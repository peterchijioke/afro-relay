import { normalizePhone } from "../phone.js";
import type {
  DeliveryStatus,
  MessagingProvider,
  NormalizedWebhookEvent,
  ProviderAttemptResult,
  ProviderErrorCode,
  SendPayload,
} from "../types.js";

export interface WhatsAppConfig {
  phoneNumberId: string;
  accessToken: string;
  /** Approved Meta Authentication template name for OTPs (e.g. "otp_verification") */
  otpTemplateName?: string;
  /** Template language code (default: "en_US") */
  languageCode?: string;
  /** Graph API version (default: "v21.0") */
  apiVersion?: string;
}

interface WhatsAppResponse {
  messages?: Array<{ id: string }>;
  error?: {
    message?: string;
    code?: number;
  };
}

function classifyWhatsAppError(status: number, code?: number): {
  code: ProviderErrorCode;
  retryable: boolean;
} {
  if (code === 131030 || code === 131026) return { code: "INVALID_NUMBER", retryable: false };
  if (status === 401 || code === 190) return { code: "AUTH_ERROR", retryable: true };
  if (status === 429 || code === 130429) return { code: "RATE_LIMITED", retryable: true };
  if (status >= 500) return { code: "PROVIDER_UNAVAILABLE", retryable: true };
  return { code: "UNKNOWN", retryable: true };
}

export class WhatsAppProvider implements MessagingProvider {
  readonly name = "whatsapp";
  readonly channels = ["whatsapp"] as const;

  private readonly phoneNumberId: string;
  private readonly accessToken: string;
  private readonly otpTemplateName?: string;
  private readonly languageCode: string;
  private readonly apiVersion: string;

  constructor(config: WhatsAppConfig) {
    if (!config.phoneNumberId) throw new Error("WhatsAppProvider requires phoneNumberId");
    if (!config.accessToken) throw new Error("WhatsAppProvider requires accessToken");
    this.phoneNumberId = config.phoneNumberId;
    this.accessToken = config.accessToken;
    this.otpTemplateName = config.otpTemplateName;
    this.languageCode = config.languageCode ?? "en_US";
    this.apiVersion = config.apiVersion ?? "v21.0";
  }

  async send(payload: SendPayload): Promise<ProviderAttemptResult> {
    const start = Date.now();
    const url = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;

    const body =
      payload.otpCode && this.otpTemplateName
        ? {
            messaging_product: "whatsapp",
            to: payload.to.bare,
            type: "template",
            template: {
              name: this.otpTemplateName,
              language: { code: this.languageCode },
              components: [
                {
                  type: "body",
                  parameters: [{ type: "text", text: payload.otpCode }],
                },
                {
                  type: "button",
                  sub_type: "url",
                  index: "0",
                  parameters: [{ type: "text", text: payload.otpCode }],
                },
              ],
            },
          }
        : {
            messaging_product: "whatsapp",
            to: payload.to.bare,
            type: "text",
            text: { body: payload.text },
          };

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(payload.timeoutMs),
        body: JSON.stringify(body),
      });

      const raw = (await response.json().catch(() => ({}))) as WhatsAppResponse;
      const latencyMs = Date.now() - start;
      const messageId = raw.messages?.[0]?.id;

      if (response.ok && messageId) {
        return {
          provider: this.name,
          channel: payload.channel,
          ok: true,
          messageId,
          retryable: false,
          latencyMs,
          raw,
        };
      }

      const classified = classifyWhatsAppError(response.status, raw.error?.code);
      return {
        provider: this.name,
        channel: payload.channel,
        ok: false,
        errorCode: classified.code,
        errorMessage: raw.error?.message ?? `WhatsApp HTTP ${response.status}`,
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
    const payload = body as {
      entry?: Array<{
        changes?: Array<{
          value?: {
            statuses?: Array<{
              id?: string;
              status?: string;
              recipient_id?: string;
              errors?: Array<{ title?: string }>;
            }>;
          };
        }>;
      }>;
    };

    const statusObj = payload.entry?.[0]?.changes?.[0]?.value?.statuses?.[0];
    if (!statusObj?.id) return null;

    const rawStatus = String(statusObj.status ?? "").toLowerCase();
    let status: DeliveryStatus = "PENDING";
    if (rawStatus === "delivered" || rawStatus === "read") status = "DELIVERED";
    else if (rawStatus === "sent") status = "ACCEPTED";
    else if (rawStatus === "failed") status = "FAILED";

    let to;
    if (typeof statusObj.recipient_id === "string") {
      try {
        to = normalizePhone(statusObj.recipient_id);
      } catch {
        // Ignore unparseable webhook phone
      }
    }

    return {
      provider: this.name,
      messageId: statusObj.id,
      status,
      to,
      reason: statusObj.errors?.[0]?.title ?? statusObj.status,
      raw: body,
    };
  }
}
