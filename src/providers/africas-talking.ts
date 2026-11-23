import { normalizePhone } from "../phone.js";
import type {
  DeliveryStatus,
  MessagingProvider,
  NormalizedWebhookEvent,
  ProviderAttemptResult,
  ProviderErrorCode,
  SendPayload,
} from "../types.js";

export interface AfricasTalkingConfig {
  apiKey: string;
  username: string;
  /** Optional registered Sender ID / Shortcode */
  from?: string;
  /** Use AT sandbox endpoint (default: false) */
  sandbox?: boolean;
}

interface ATRecipient {
  statusCode: number;
  number: string;
  status: string;
  cost?: string;
  messageId?: string;
}

interface ATSendResponse {
  SMSMessageData?: {
    Message?: string;
    Recipients?: ATRecipient[];
  };
}

function classifyATStatusCode(code: number): {
  code: ProviderErrorCode;
  retryable: boolean;
} {
  if (code === 403) return { code: "INVALID_NUMBER", retryable: false };
  if (code === 405) return { code: "INSUFFICIENT_BALANCE", retryable: true };
  if (code === 406) return { code: "DND_BLOCKED", retryable: true };
  if (code === 402 || code === 407) return { code: "INVALID_SENDER_ID", retryable: true };
  if (code >= 500) return { code: "PROVIDER_UNAVAILABLE", retryable: true };
  return { code: "UNKNOWN", retryable: true };
}

export class AfricasTalkingProvider implements MessagingProvider {
  readonly name = "africas-talking";
  readonly channels = ["sms"] as const;
  readonly senderId?: string;

  private readonly apiKey: string;
  private readonly username: string;
  private readonly from?: string;
  private readonly endpoint: string;

  constructor(config: AfricasTalkingConfig) {
    if (!config.apiKey) throw new Error("AfricasTalkingProvider requires apiKey");
    if (!config.username) throw new Error("AfricasTalkingProvider requires username");
    this.apiKey = config.apiKey;
    this.username = config.username;
    this.from = config.from;
    this.senderId = config.from;
    this.endpoint = config.sandbox
      ? "https://api.sandbox.africastalking.com/version1/messaging"
      : "https://api.africastalking.com/version1/messaging";
  }

  async send(payload: SendPayload): Promise<ProviderAttemptResult> {
    const start = Date.now();
    const form = new URLSearchParams({
      username: this.username,
      to: payload.to.e164,
      message: payload.text,
    });
    if (this.from) {
      form.set("from", this.from);
    }

    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          apiKey: this.apiKey,
        },
        signal: AbortSignal.timeout(payload.timeoutMs),
        body: form.toString(),
      });

      const raw = (await response.json().catch(() => ({}))) as ATSendResponse;
      const latencyMs = Date.now() - start;
      const recipient = raw.SMSMessageData?.Recipients?.[0];

      if (response.ok && recipient && (recipient.statusCode === 100 || recipient.statusCode === 101 || recipient.statusCode === 102)) {
        return {
          provider: this.name,
          channel: payload.channel,
          ok: true,
          messageId: recipient.messageId,
          retryable: false,
          latencyMs,
          raw,
        };
      }

      if (recipient) {
        const classified = classifyATStatusCode(recipient.statusCode);
        return {
          provider: this.name,
          channel: payload.channel,
          ok: false,
          errorCode: classified.code,
          errorMessage: recipient.status,
          retryable: classified.retryable,
          latencyMs,
          raw,
        };
      }

      return {
        provider: this.name,
        channel: payload.channel,
        ok: false,
        errorCode: response.status === 401 ? "AUTH_ERROR" : "PROVIDER_UNAVAILABLE",
        errorMessage: raw.SMSMessageData?.Message ?? `Africa's Talking HTTP ${response.status}`,
        retryable: true,
        latencyMs,
        raw,
      };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const isTimeout = err instanceof Error && err.name === "TimeoutError";
      return {
        provider: this.name,
        channel: payload.channel,
        ok: false,
        errorCode: isTimeout ? "TIMEOUT" : "PROVIDER_UNAVAILABLE",
        errorMessage: err instanceof Error ? err.message : String(err),
        retryable: true,
        ...(isTimeout ? { maybeSent: true } : {}),
        latencyMs,
      };
    }
  }

  parseWebhook(body: unknown): NormalizedWebhookEvent | null {
    if (!body || typeof body !== "object") return null;
    const data = body as Record<string, unknown>;
    const messageId = typeof data.id === "string" ? data.id : null;
    if (!messageId) return null;

    const rawStatus = String(data.status ?? "").toLowerCase();
    const failureReason = String(data.failureReason ?? "");
    let status: DeliveryStatus = "PENDING";

    if (failureReason.toLowerCase().includes("blacklist") || failureReason.toLowerCase().includes("dnd")) {
      status = "DND_REJECTED";
    } else if (rawStatus === "failed" || rawStatus === "rejected" || rawStatus === "undelivered") {
      status = "FAILED";
    } else if (rawStatus === "expired") {
      status = "EXPIRED";
    } else if (rawStatus === "success" || rawStatus === "delivered") {
      status = "DELIVERED";
    } else if (
      rawStatus === "sent" ||
      rawStatus === "submitted" ||
      rawStatus === "buffered" ||
      rawStatus === "queued"
    ) {
      status = "ACCEPTED";
    }

    let to;
    if (typeof data.phoneNumber === "string") {
      try {
        to = normalizePhone(data.phoneNumber);
      } catch {
        // Ignore unparseable webhook phone
      }
    }

    const isTerminal =
      status === "DELIVERED" ||
      status === "FAILED" ||
      status === "DND_REJECTED" ||
      status === "EXPIRED";

    return {
      provider: this.name,
      messageId,
      status,
      isTerminal,
      to,
      reason: failureReason || (typeof data.status === "string" ? data.status : undefined),
      raw: body,
    };
  }
}
