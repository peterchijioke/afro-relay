import { normalizePhone } from "../phone.js";
import type {
  DeliveryStatus,
  MessagingProvider,
  NormalizedWebhookEvent,
  ProviderAttemptResult,
  ProviderErrorCode,
  SendPayload,
} from "../types.js";

export interface SendchampConfig {
  publicKey: string;
  senderName: string;
  /** Defaults to "dnd" for OTPs and "non_dnd" otherwise */
  route?: "dnd" | "non_dnd" | "international";
  /** Override base URL (default: https://api.sendchamp.com/api/v1) */
  baseUrl?: string;
}

interface SendchampResponse {
  status?: string;
  code?: number;
  message?: string;
  data?: {
    id?: string;
    business?: string;
    status?: string;
  };
}

function classifySendchampError(status: number, message: string): {
  code: ProviderErrorCode;
  retryable: boolean;
} {
  const lower = message.toLowerCase();
  if (lower.includes("insufficient") || lower.includes("wallet") || lower.includes("balance")) {
    return { code: "INSUFFICIENT_BALANCE", retryable: true };
  }
  if (lower.includes("invalid") && (lower.includes("phone") || lower.includes("number"))) {
    return { code: "INVALID_NUMBER", retryable: false };
  }
  if (lower.includes("sender")) {
    return { code: "INVALID_SENDER_ID", retryable: true };
  }
  if (lower.includes("dnd")) {
    return { code: "DND_BLOCKED", retryable: true };
  }
  if (status === 401 || status === 403) {
    return { code: "AUTH_ERROR", retryable: true };
  }
  if (status === 429) {
    return { code: "RATE_LIMITED", retryable: true };
  }
  if (status >= 500) {
    return { code: "PROVIDER_UNAVAILABLE", retryable: true };
  }
  return { code: "UNKNOWN", retryable: true };
}

export class SendchampProvider implements MessagingProvider {
  readonly name = "sendchamp";
  readonly channels = ["sms"] as const;

  private readonly publicKey: string;
  private readonly senderName: string;
  private readonly defaultRoute?: "dnd" | "non_dnd" | "international";
  private readonly baseUrl: string;

  constructor(config: SendchampConfig) {
    if (!config.publicKey) throw new Error("SendchampProvider requires publicKey");
    if (!config.senderName) throw new Error("SendchampProvider requires senderName");
    this.publicKey = config.publicKey;
    this.senderName = config.senderName;
    this.defaultRoute = config.route;
    this.baseUrl = (config.baseUrl ?? "https://api.sendchamp.com/api/v1").replace(/\/$/, "");
  }

  async send(payload: SendPayload): Promise<ProviderAttemptResult> {
    const start = Date.now();
    const route = this.defaultRoute ?? (payload.otpCode ? "dnd" : "non_dnd");

    try {
      const response = await fetch(`${this.baseUrl}/sms/send`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.publicKey}`,
        },
        signal: AbortSignal.timeout(payload.timeoutMs),
        body: JSON.stringify({
          to: [payload.to.bare],
          message: payload.text,
          sender_name: this.senderName,
          route,
        }),
      });

      const raw = (await response.json().catch(() => ({}))) as SendchampResponse;
      const latencyMs = Date.now() - start;

      if (response.ok && (raw.status === "success" || Boolean(raw.data?.id))) {
        return {
          provider: this.name,
          channel: payload.channel,
          ok: true,
          messageId: raw.data?.id,
          retryable: false,
          latencyMs,
          raw,
        };
      }

      const errorMessage = raw.message ?? `Sendchamp HTTP ${response.status}`;
      const classified = classifySendchampError(response.status, errorMessage);
      return {
        provider: this.name,
        channel: payload.channel,
        ok: false,
        errorCode: classified.code,
        errorMessage,
        retryable: classified.retryable,
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
        latencyMs,
      };
    }
  }

  parseWebhook(body: unknown): NormalizedWebhookEvent | null {
    if (!body || typeof body !== "object") return null;
    const data = body as Record<string, unknown>;
    const payload = (
      data.data && typeof data.data === "object" ? data.data : data
    ) as Record<string, unknown>;

    const messageId =
      typeof payload.id === "string"
        ? payload.id
        : typeof payload.uid === "string"
          ? payload.uid
          : null;
    if (!messageId) return null;

    const rawStatus = String(payload.status ?? "").toLowerCase();
    let status: DeliveryStatus = "PENDING";
    if (rawStatus.includes("deliver")) status = "DELIVERED";
    else if (rawStatus.includes("dnd")) status = "DND_REJECTED";
    else if (rawStatus.includes("fail") || rawStatus.includes("reject")) status = "FAILED";
    else if (rawStatus.includes("expir")) status = "EXPIRED";

    let to;
    const phoneStr =
      typeof payload.phone_number === "string"
        ? payload.phone_number
        : typeof payload.to === "string"
          ? payload.to
          : null;
    if (phoneStr) {
      try {
        to = normalizePhone(phoneStr);
      } catch {
        // Ignore unparseable webhook phone
      }
    }

    return {
      provider: this.name,
      messageId,
      status,
      to,
      reason: typeof payload.status === "string" ? payload.status : undefined,
      raw: body,
    };
  }
}
