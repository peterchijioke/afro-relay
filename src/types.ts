export type Channel = "sms" | "whatsapp" | "voice";

export type DeliveryStatus =
  | "ACCEPTED"
  | "DELIVERED"
  | "FAILED"
  | "DND_REJECTED"
  | "EXPIRED"
  | "PENDING";

export type ProviderErrorCode =
  | "TIMEOUT"
  | "INSUFFICIENT_BALANCE"
  | "RATE_LIMITED"
  | "INVALID_NUMBER"
  | "DND_BLOCKED"
  | "INVALID_SENDER_ID"
  | "AUTH_ERROR"
  | "PROVIDER_UNAVAILABLE"
  | "UNKNOWN";

export type CountryCode = "NG" | "KE" | "GH" | "UNKNOWN";

export type TelcoName =
  | "MTN"
  | "AIRTEL"
  | "GLO"
  | "9MOBILE"
  | "SAFARICOM"
  | "TELKOM"
  | "TELECEL"
  | "AIRTELTIGO"
  | "UNKNOWN";

export interface NormalizedPhone {
  /** E.164 format with leading '+', e.g. "+2348031234567" */
  e164: string;
  /** Digits only with country code (no '+'), e.g. "2348031234567" */
  bare: string;
  /** Detected ISO-2 country code */
  country: CountryCode;
  /** Detected mobile network operator (best-effort from prefix) */
  telco: TelcoName;
}

export interface SendPayload {
  to: NormalizedPhone;
  text: string;
  otpCode?: string;
  channel: Channel;
  timeoutMs: number;
  metadata?: Record<string, string>;
}

export interface ProviderAttemptResult {
  provider: string;
  channel: Channel;
  ok: boolean;
  messageId?: string;
  errorCode?: ProviderErrorCode;
  errorMessage?: string;
  /** If false (e.g. INVALID_NUMBER), router stops failover immediately */
  retryable: boolean;
  /**
   * True when the outcome is ambiguous (e.g. HTTP TIMEOUT) and the gateway may
   * have already accepted and queued the message.
   */
  maybeSent?: boolean;
  latencyMs: number;
  raw?: unknown;
}

export interface NormalizedWebhookEvent {
  provider: string;
  messageId: string;
  status: DeliveryStatus;
  /**
   * True only for final handset/carrier outcomes (DELIVERED, FAILED, DND_REJECTED, EXPIRED).
   * False for intermediate gateway/carrier acceptance states (ACCEPTED, PENDING).
   * Only trigger receipt-driven failover on a terminal miss (`isTerminal && status !== "DELIVERED"`).
   */
  isTerminal: boolean;
  to?: NormalizedPhone;
  reason?: string;
  raw: unknown;
}

export interface MessagingProvider {
  readonly name: string;
  readonly channels: readonly Channel[];
  /** Optional sender ID / from address used to scope sender-specific telco drops */
  readonly senderId?: string;
  /** True if this provider is configured to bypass DND (e.g. Termii/Sendchamp "dnd" route) */
  readonly dndCapable?: boolean;
  send(payload: SendPayload): Promise<ProviderAttemptResult>;
  parseWebhook?(
    body: unknown,
    headers?: Record<string, string | undefined>,
  ): NormalizedWebhookEvent | null;
}

export type BreakerSignal = "submit" | "delivery";

export interface BreakerScope {
  provider: string;
  country?: CountryCode | "*";
  telco: TelcoName | "*";
  senderId?: string;
  signal?: BreakerSignal;
}

export interface BreakerState {
  failures: number;
  openUntil: number | null;
  /** Recent outcomes (1 = success, 0 = failure) when sliding-window mode is enabled */
  window?: number[];
}

export interface CircuitBreakerStore {
  get(key: string): Promise<BreakerState | null> | BreakerState | null;
  set(key: string, state: BreakerState): Promise<void> | void;
  delete(key: string): Promise<void> | void;
}

export interface CircuitBreakerOptions {
  /** Consecutive failures (or failures in window) before tripping the breaker (default: 5) */
  failureThreshold?: number;
  /** Cooldown duration in milliseconds while breaker stays OPEN (default: 600_000 = 10 min) */
  cooldownMs?: number;
  /**
   * Optional sliding window size (number of recent outcomes to track).
   * When set, the breaker trips once at least `failureThreshold` failures occur
   * AND the failure rate in the window is >= `failureRateThreshold` (default: 0.5).
   */
  windowSize?: number;
  /** Minimum failure rate (0..1) required to trip when `windowSize` is set (default: 0.5) */
  failureRateThreshold?: number;
  /** Pluggable store (defaults to in-memory; pass Redis adapter for multi-instance prod) */
  store?: CircuitBreakerStore;
}

export interface RouterOptions {
  providers: MessagingProvider[];
  /** Default country for local numbers like "0803..." (default: "NG") */
  defaultCountry?: Exclude<CountryCode, "UNKNOWN">;
  /** Per-provider HTTP timeout in milliseconds (default: 5000) */
  timeoutMs?: number;
  /**
   * Whether to immediately fail over to the next provider after an HTTP TIMEOUT.
   * Defaults to `false` to avoid sending duplicate OTPs when the first gateway
   * accepted the request before timing out. Set `true` to prioritize latency over
   * duplicate-send risk (ensure the same OTP code is reused across attempts).
   */
  failoverOnTimeout?: boolean;
  /** Telco-aware circuit breaker configuration */
  circuitBreaker?: CircuitBreakerOptions | false;
  /** Optional hook for structured logging / metrics */
  onAttempt?: (attempt: ProviderAttemptResult, phone: NormalizedPhone) => void;
}

export interface SendMessageInput {
  to: string;
  text: string;
  otpCode?: string;
  /** Ordered channels to try (default: ["sms"]) */
  channels?: Channel[];
  /** Override default country for this call */
  country?: Exclude<CountryCode, "UNKNOWN">;
  /** Override prefix-detected carrier (useful when you have HLR/MNP portability data) */
  telco?: TelcoName;
  /** Override per-provider timeout for this call */
  timeoutMs?: number;
  /** Override router-level `failoverOnTimeout` for this call */
  failoverOnTimeout?: boolean;
  metadata?: Record<string, string>;
}

export interface SendOTPInput {
  to: string;
  code: string;
  /** Optional custom message template; defaults to "Your verification code is {code}." */
  message?: string;
  /** Ordered channels to try (default: ["sms", "whatsapp"]) */
  fallbackChannels?: Channel[];
  country?: Exclude<CountryCode, "UNKNOWN">;
  /** Override prefix-detected carrier (useful when you have HLR/MNP portability data) */
  telco?: TelcoName;
  timeoutMs?: number;
  /** Override router-level `failoverOnTimeout` for this call */
  failoverOnTimeout?: boolean;
  metadata?: Record<string, string>;
}

export interface RouterSendResult {
  ok: boolean;
  phone: NormalizedPhone;
  usedProvider?: string;
  usedChannel?: Channel;
  messageId?: string;
  /**
   * True if at least one provider attempt timed out in an ambiguous state
   * (the message may still be delivered by that provider).
   */
  maybeSent?: boolean;
  attempts: ProviderAttemptResult[];
  skippedProviders: Array<{ provider: string; reason: string }>;
}
