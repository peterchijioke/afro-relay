import { normalizePhone } from "../phone.js";
import type {
  DeliveryStatus,
  MessagingProvider,
  NormalizedWebhookEvent,
  ProviderAttemptResult,
  ProviderErrorCode,
  SendPayload,
} from "../types.js";

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  /** Twilio phone number (e.g. "+15551234567") or MessagingServiceSid ("MG...") */
  from: string;
  /** Override base URL (default: https://api.twilio.com) */
  baseUrl?: string;
}

interface TwilioResponse {
  sid?: string;
  status?: string;
  code?: number;
  message?: string;
}

function classifyTwilioError(status: number, code?: number): {
  code: ProviderErrorCode;
  retryable: boolean;
} {
  if (code === 21211 || code === 21614 || code === 21408) {
    return { code: "INVALID_NUMBER", retryable: false };
  }
  if (code === 21610) {
    return { code: "DND_BLOCKED", retryable: true };
  }
  if (code === 20003 || status === 401 || status === 403) {
    return { code: "AUTH_ERROR", retryable: true };
  }
  if (status === 429 || code === 20429) {
    return { code: "RATE_LIMITED", retryable: true };
  }
  if (status >= 500) {
    return { code: "PROVIDER_UNAVAILABLE", retryable: true };
  }
  return { code: "UNKNOWN", retryable: true };
}

export class TwilioProvider implements MessagingProvider {
  readonly name = "twilio";
  readonly channels = ["sms"] as const;

  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly from: string;
  private readonly baseUrl: string;

  constructor(config: TwilioConfig) {
    if (!config.accountSid) throw new Error("TwilioProvider requires accountSid");
    if (!config.authToken) throw new Error("TwilioProvider requires authToken");
    if (!config.from) throw new Error("TwilioProvider requires from");
    this.accountSid = config.accountSid;
    this.authToken = config.authToken;
    this.from = config.from;
    this.baseUrl = (config.baseUrl ?? "https://api.twilio.com").replace(/\/$/, "");
  }

  async send(payload: SendPayload): Promise<ProviderAttemptResult> {
    const start = Date.now();
    const url = `${this.baseUrl}/2010-04-01/Accounts/${this.accountSid}/Messages.json`;

    const form = new URLSearchParams({
      To: payload.to.e164,
      Body: payload.text,
    });
    if (this.from.startsWith("MG")) {
      form.set("MessagingServiceSid", this.from);
    } else {
      form.set("From", this.from);
    }

    const credentials = btoa(`${this.accountSid}:${this.authToken}`);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        signal: AbortSignal.timeout(payload.timeoutMs),
        body: form.toString(),
      });

      const raw = (await response.json().catch(() => ({}))) as TwilioResponse;
      const latencyMs = Date.now() - start;

      if (response.ok && raw.sid) {
        return {
          provider: this.name,
          channel: payload.channel,
          ok: true,
          messageId: raw.sid,
          retryable: false,
          latencyMs,
          raw,
        };
      }

      const classified = classifyTwilioError(response.status, raw.code);
      return {
        provider: this.name,
        channel: payload.channel,
        ok: false,
        errorCode: classified.code,
        errorMessage: raw.message ?? `Twilio HTTP ${response.status}`,
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
    const messageId = typeof data.MessageSid === "string" ? data.MessageSid : null;
    if (!messageId) return null;

    const rawStatus = String(data.MessageStatus ?? "").toLowerCase();
    let status: DeliveryStatus = "PENDING";
    if (rawStatus === "delivered") status = "DELIVERED";
    else if (rawStatus === "sent" || rawStatus === "queued") status = "ACCEPTED";
    else if (rawStatus === "failed" || rawStatus === "undelivered") status = "FAILED";

    let to;
    if (typeof data.To === "string") {
      try {
        to = normalizePhone(data.To);
      } catch {
        // Ignore unparseable webhook phone
      }
    }

    return {
      provider: this.name,
      messageId,
      status,
      to,
      reason: typeof data.ErrorMessage === "string" ? data.ErrorMessage : rawStatus,
      raw: body,
    };
  }
}
