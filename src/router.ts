import { TelcoCircuitBreaker } from "./circuit-breaker.js";
import { normalizePhone } from "./phone.js";
import type {
  BreakerScope,
  Channel,
  CountryCode,
  MessagingProvider,
  NormalizedPhone,
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
  private readonly failoverOnTimeout: boolean;
  private readonly breaker: TelcoCircuitBreaker | null;
  private readonly onAttempt?: RouterOptions["onAttempt"];

  constructor(options: RouterOptions) {
    if (!options.providers || options.providers.length === 0) {
      throw new Error("MessageRouter requires at least one provider");
    }
    this.providers = options.providers;
    this.defaultCountry = options.defaultCountry ?? "NG";
    this.defaultTimeoutMs = options.timeoutMs ?? 5000;
    this.failoverOnTimeout = options.failoverOnTimeout ?? false;
    this.breaker =
      options.circuitBreaker === false
        ? null
        : new TelcoCircuitBreaker(options.circuitBreaker);
    this.onAttempt = options.onAttempt;
  }

  private globalSubmitScope(provider: MessagingProvider): BreakerScope {
    return {
      provider: provider.name,
      country: "*",
      telco: "*",
      signal: "submit",
    };
  }

  private routeSubmitScope(provider: MessagingProvider, phone: NormalizedPhone): BreakerScope {
    return {
      provider: provider.name,
      country: phone.country,
      telco: phone.telco,
      senderId: provider.senderId,
      signal: "submit",
    };
  }

  private routeDeliveryScope(provider: MessagingProvider, phone: NormalizedPhone): BreakerScope {
    return {
      provider: provider.name,
      country: phone.country,
      telco: phone.telco,
      senderId: provider.senderId,
      signal: "delivery",
    };
  }

  private async findOpenCircuit(
    provider: MessagingProvider,
    phone: NormalizedPhone,
  ): Promise<BreakerScope | null> {
    if (!this.breaker) return null;
    const scopes = [
      this.globalSubmitScope(provider),
      this.routeSubmitScope(provider, phone),
      this.routeDeliveryScope(provider, phone),
    ];
    for (const scope of scopes) {
      if (await this.breaker.isOpen(scope)) {
        return scope;
      }
    }
    return null;
  }

  async send(input: SendMessageInput): Promise<RouterSendResult> {
    const normalized = normalizePhone(input.to, input.country ?? this.defaultCountry);
    const phone: NormalizedPhone = input.telco
      ? { ...normalized, telco: input.telco }
      : normalized;
    const channels: Channel[] = input.channels?.length ? input.channels : ["sms"];
    const timeoutMs = input.timeoutMs ?? this.defaultTimeoutMs;
    const failoverOnTimeout = input.failoverOnTimeout ?? this.failoverOnTimeout;

    const attempts: ProviderAttemptResult[] = [];
    const skippedProviders: Array<{ provider: string; reason: string }> = [];
    let firstSkippedCandidate: { provider: MessagingProvider; channel: Channel } | null = null;
    let maybeSent = false;

    for (const channel of channels) {
      const candidates = this.providers.filter((p) => p.channels.includes(channel));
      let sawDndOnChannel = false;

      for (const provider of candidates) {
        // After a DND rejection on SMS, skip remaining non-DND SMS routes and
        // prefer DND-capable SMS providers or escalate to the next channel (e.g. WhatsApp).
        if (channel === "sms" && sawDndOnChannel && !provider.dndCapable) {
          skippedProviders.push({
            provider: provider.name,
            reason: "dnd_escalated",
          });
          continue;
        }

        const openScope = await this.findOpenCircuit(provider, phone);
        if (openScope) {
          if (!firstSkippedCandidate) {
            firstSkippedCandidate = { provider, channel };
          }
          skippedProviders.push({
            provider: provider.name,
            reason: `circuit_open:${TelcoCircuitBreaker.makeKey(openScope)}`,
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
        if (attempt.maybeSent) {
          maybeSent = true;
        }
        this.onAttempt?.(attempt, phone);

        if (attempt.ok) {
          if (this.breaker) {
            // HTTP 200 OK only proves gateway acceptance, NOT final telco delivery.
            // Reset submit health only; delivery health is controlled exclusively by DLR webhooks.
            await this.breaker.recordSuccess(this.globalSubmitScope(provider));
            await this.breaker.recordSuccess(this.routeSubmitScope(provider, phone));
          }
          return {
            ok: true,
            phone,
            usedProvider: provider.name,
            usedChannel: channel,
            messageId: attempt.messageId,
            ...(maybeSent ? { maybeSent: true } : {}),
            attempts,
            skippedProviders,
          };
        }

        // Non-retryable error (e.g. INVALID_NUMBER): stop immediately without tripping breaker
        if (!attempt.retryable) {
          return {
            ok: false,
            phone,
            ...(maybeSent ? { maybeSent: true } : {}),
            attempts,
            skippedProviders,
          };
        }

        // DND is a recipient/route signal, NOT a telco outage: never trip the health breaker.
        if (attempt.errorCode === "DND_BLOCKED") {
          sawDndOnChannel = true;
          continue;
        }

        if (this.breaker) {
          if (
            attempt.errorCode === "AUTH_ERROR" ||
            attempt.errorCode === "INSUFFICIENT_BALANCE"
          ) {
            // Provider-wide account failure: share circuit across all countries & telcos.
            await this.breaker.recordFailure(this.globalSubmitScope(provider));
          } else {
            await this.breaker.recordFailure(this.routeSubmitScope(provider, phone));
          }
        }

        // Ambiguous timeout: the first gateway may have already queued the SMS.
        // Stop by default to avoid putting a duplicate OTP on the wire unless opted in.
        if (attempt.errorCode === "TIMEOUT" && !failoverOnTimeout) {
          return {
            ok: false,
            phone,
            maybeSent: true,
            attempts,
            skippedProviders,
          };
        }
      }
    }

    // Fail-open probe: if EVERY candidate was skipped due to open circuits,
    // probe the first eligible provider as a last resort rather than guaranteeing 100% failure.
    if (attempts.length === 0 && firstSkippedCandidate) {
      const { provider, channel } = firstSkippedCandidate;
      const probe = await provider.send({
        to: phone,
        text: input.text,
        otpCode: input.otpCode,
        channel,
        timeoutMs,
        metadata: input.metadata,
      });
      attempts.push(probe);
      if (probe.maybeSent) {
        maybeSent = true;
      }
      this.onAttempt?.(probe, phone);

      if (probe.ok) {
        if (this.breaker) {
          await this.breaker.recordSuccess(this.globalSubmitScope(provider));
          await this.breaker.recordSuccess(this.routeSubmitScope(provider, phone));
        }
        return {
          ok: true,
          phone,
          usedProvider: provider.name,
          usedChannel: channel,
          messageId: probe.messageId,
          ...(maybeSent ? { maybeSent: true } : {}),
          attempts,
          skippedProviders,
        };
      }
    }

    return {
      ok: false,
      phone,
      ...(maybeSent ? { maybeSent: true } : {}),
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
      telco: input.telco,
      timeoutMs: input.timeoutMs,
      failoverOnTimeout: input.failoverOnTimeout,
      metadata: input.metadata,
    });
  }

  /**
   * Parses a delivery receipt webhook from a registered provider and feeds
   * final FAILED / EXPIRED receipts into the delivery circuit breaker.
   * DND_REJECTED receipts are returned without tripping the telco outage breaker.
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
      const deliveryScope = this.routeDeliveryScope(provider, event.to);
      if (event.status === "DELIVERED") {
        await this.breaker.recordSuccess(deliveryScope);
      } else if (event.status === "FAILED" || event.status === "EXPIRED") {
        await this.breaker.recordFailure(deliveryScope);
      }
    }

    return event;
  }
}
