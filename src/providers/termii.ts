import { normalizePhone } from "../phone.js";
import type {
  DeliveryStatus,
  MessagingProvider,
  NormalizedWebhookEvent,
  ProviderAttemptResult,
  ProviderErrorCode,
  SendPayload,
} from "../types.js";

export interface TermiiConfig {
  apiKey: string;
  senderId: string;
  /** Defaults to "dnd" for OTPs and "generic" otherwise */
  channel?: "dnd" | "generic" | "whatsapp";
  /** Override base URL (default: https://v3.api.termii.com) */
  baseUrl?: string;
}

interface TermiiSendResponse {
  message_id?: string;
  message?: string;
  code?: string;
  balance?: number;
}

function classifyTermiiError(status: number, message: string): {
  code: ProviderErrorCode;
  retryable: boolean;
} {
  const lower = message.toLowerCase();
  if (lower.includes("insufficient") || lower.includes("balance")) {
    return { code: "INSUFFICIENT_BALANCE", retryable: true };
  }
  if (lower.includes("invalid") && lower.includes("number")) {
    return { code: "INVALID_NUMBER", retryable: false };
  }
  if (lower.includes("sender") && lower.includes("id")) {
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

export class TermiiProvider implements MessagingProvider {
  readonly name = "termii";
  readonly channels = ["sms"] as const;
  readonly senderId: string;
  readonly dndCapable: boolean;

  private readonly apiKey: string;
  private readonly defaultChannel?: "dnd" | "generic" | "whatsapp";
  private readonly baseUrl: string;

  constructor(config: TermiiConfig) {
    if (!config.apiKey) throw new Error("TermiiProvider requires apiKey");
    if (!config.senderId) throw new Error("TermiiProvider requires senderId");
    this.apiKey = config.apiKey;
    this.senderId = config.senderId;
    this.defaultChannel = config.channel;
    this.dndCapable = config.channel === undefined || config.channel === "dnd";
    this.baseUrl = (config.baseUrl ?? "https://v3.api.termii.com").replace(/\/$/, "");
  }

  async send(payload: SendPayload): Promise<ProviderAttemptResult> {
    const start = Date.now();
    const channel = this.defaultChannel ?? (payload.otpCode ? "dnd" : "generic");

    try {
      const response = await fetch(`${this.baseUrl}/api/sms/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(payload.timeoutMs),
        body: JSON.stringify({
          to: payload.to.bare,
          from: this.senderId,
          sms: payload.text,
          type: "plain",
          channel,
          api_key: this.apiKey,
        }),
      });

      const raw = (await response.json().catch(() => ({}))) as TermiiSendResponse;
      const latencyMs = Date.now() - start;

      // Termii returns code === "ok" and message_id on success
      if (response.ok && (raw.code === "ok" || Boolean(raw.message_id))) {
        return {
          provider: this.name,
          channel: payload.channel,
          ok: true,
          messageId: raw.message_id,
          retryable: false,
          latencyMs,
          raw,
        };
      }

      const errorMessage = raw.message ?? `Termii HTTP ${response.status}`;
      const classified = classifyTermiiError(response.status, errorMessage);
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
        ...(isTimeout ? { maybeSent: true } : {}),
        latencyMs,
      };
    }
  }

  parseWebhook(body: unknown): NormalizedWebhookEvent | null {
    if (!body || typeof body !== "object") return null;
    const data = body as Record<string, unknown>;
    const messageId =
      typeof data.message_id === "string"
        ? data.message_id
        : typeof data.msg_id === "string"
          ? data.msg_id
          : null;

    if (!messageId) return null;

    const rawStatus = String(data.status ?? "").toLowerCase();
    let status: DeliveryStatus = "PENDING";
    if (rawStatus.includes("dnd")) {
      status = "DND_REJECTED";
    } else if (
      rawStatus.includes("undeliver") ||
      rawStatus.includes("not deliver") ||
      rawStatus.includes("reject") ||
      rawStatus.includes("fail")
    ) {
      status = "FAILED";
    } else if (rawStatus.includes("expir")) {
      status = "EXPIRED";
    } else if (rawStatus.includes("deliver")) {
      status = "DELIVERED";
    } else if (
      rawStatus.includes("sent") ||
      rawStatus.includes("submit") ||
      rawStatus.includes("queue") ||
      rawStatus.includes("accept") ||
      rawStatus.includes("buffer")
    ) {
      status = "ACCEPTED";
    }

    let to;
    if (typeof data.receiver === "string") {
      try {
        to = normalizePhone(data.receiver);
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
      reason: typeof data.status === "string" ? data.status : undefined,
      raw: body,
    };
  }
}
