import { TelcoCircuitBreaker } from "./circuit-breaker.js";
import { normalizePhone } from "./phone.js";
import type {
  Channel,
  CountryCode,
  MessagingProvider,
  NormalizedWebhookEvent,
  ProviderAttemptResult,
  RouterOptions,
  RouterSendResult,
  SendMessageInput,
  SendOTPInput,
} from "./types.js";

export class MessageRouter {
  private readonly providers: MessagingProvider[];
  private readonly defaultCountry: Exclude<CountryCode, "UNKNOWN">;
  private readonly defaultTimeoutMs: number;
  private readonly breaker: TelcoCircuitBreaker | null;
  private readonly onAttempt?: RouterOptions["onAttempt"];

  constructor(options: RouterOptions) {
    if (!options.providers || options.providers.length === 0) {
      throw new Error("MessageRouter requires at least one provider");
    }
    this.providers = options.providers;
    this.defaultCountry = options.defaultCountry ?? "NG";
    this.defaultTimeoutMs = options.timeoutMs ?? 5000;
    this.breaker =
      options.circuitBreaker === false
        ? null
        : new TelcoCircuitBreaker(options.circuitBreaker);
    this.onAttempt = options.onAttempt;
  }

  async send(input: SendMessageInput): Promise<RouterSendResult> {
    const phone = normalizePhone(input.to, input.country ?? this.defaultCountry);
    const channels: Channel[] = input.channels?.length ? input.channels : ["sms"];
    const timeoutMs = input.timeoutMs ?? this.defaultTimeoutMs;

    const attempts: ProviderAttemptResult[] = [];
    const skippedProviders: Array<{ provider: string; reason: string }> = [];

    for (const channel of channels) {
      const candidates = this.providers.filter((p) => p.channels.includes(channel));

      for (const provider of candidates) {
        if (this.breaker && (await this.breaker.isOpen(provider.name, phone.telco))) {
          skippedProviders.push({
            provider: provider.name,
            reason: `circuit_open:${provider.name}:${phone.telco}`,
          });
          continue;
        }

        const attempt = await provider.send({
          to: phone,
          text: input.text,
          otpCode: input.otpCode,
          channel,
          timeoutMs,
          metadata: input.metadata,
        });

        attempts.push(attempt);
        this.onAttempt?.(attempt, phone);

        if (attempt.ok) {
          if (this.breaker) {
            await this.breaker.recordSuccess(provider.name, phone.telco);
          }
          return {
            ok: true,
            phone,
            usedProvider: provider.name,
            usedChannel: channel,
            messageId: attempt.messageId,
            attempts,
            skippedProviders,
          };
        }

        // Non-retryable error (e.g. INVALID_NUMBER): stop immediately without tripping breaker
        if (!attempt.retryable) {
          return {
            ok: false,
            phone,
            attempts,
            skippedProviders,
          };
        }

        if (this.breaker) {
          await this.breaker.recordFailure(provider.name, phone.telco);
        }
      }
    }

    return {
      ok: false,
      phone,
      attempts,
      skippedProviders,
    };
  }

  async sendOTP(input: SendOTPInput): Promise<RouterSendResult> {
    const text = input.message
      ? input.message.replace(/\{code\}/g, input.code)
      : `Your verification code is ${input.code}.`;

    return this.send({
      to: input.to,
      text,
      otpCode: input.code,
      channels: input.fallbackChannels ?? ["sms", "whatsapp"],
      country: input.country,
      timeoutMs: input.timeoutMs,
      metadata: input.metadata,
    });
  }

  /**
   * Parses a delivery receipt webhook from a registered provider and feeds
   * FAILED / DND_REJECTED receipts back into the telco-aware circuit breaker.
   */
  async handleWebhook(
    providerName: string,
    body: unknown,
    headers?: Record<string, string | undefined>,
  ): Promise<NormalizedWebhookEvent | null> {
    const provider = this.providers.find((p) => p.name === providerName);
    if (!provider?.parseWebhook) return null;

    const event = provider.parseWebhook(body, headers);
    if (!event) return null;

    if (this.breaker && event.to) {
      if (event.status === "DELIVERED") {
        await this.breaker.recordSuccess(provider.name, event.to.telco);
      } else if (event.status === "FAILED" || event.status === "DND_REJECTED") {
        await this.breaker.recordFailure(provider.name, event.to.telco);
      }
    }

    return event;
  }
}
