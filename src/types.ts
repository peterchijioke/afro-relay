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
  latencyMs: number;
  raw?: unknown;
}

export interface NormalizedWebhookEvent {
  provider: string;
  messageId: string;
  status: DeliveryStatus;
  to?: NormalizedPhone;
  reason?: string;
  raw: unknown;
}

export interface MessagingProvider {
  readonly name: string;
  readonly channels: readonly Channel[];
  send(payload: SendPayload): Promise<ProviderAttemptResult>;
  parseWebhook?(
    body: unknown,
    headers?: Record<string, string | undefined>,
  ): NormalizedWebhookEvent | null;
}

export interface BreakerState {
  failures: number;
  openUntil: number | null;
}

export interface CircuitBreakerStore {
  get(key: string): Promise<BreakerState | null> | BreakerState | null;
  set(key: string, state: BreakerState): Promise<void> | void;
  delete(key: string): Promise<void> | void;
}

export interface CircuitBreakerOptions {
  /** Consecutive failures before tripping the breaker (default: 5) */
  failureThreshold?: number;
  /** Cooldown duration in milliseconds while breaker stays OPEN (default: 600_000 = 10 min) */
  cooldownMs?: number;
  /** Pluggable store (defaults to in-memory; pass Redis adapter for multi-instance prod) */
  store?: CircuitBreakerStore;
}

export interface RouterOptions {
  providers: MessagingProvider[];
  /** Default country for local numbers like "0803..." (default: "NG") */
  defaultCountry?: Exclude<CountryCode, "UNKNOWN">;
  /** Per-provider HTTP timeout in milliseconds (default: 5000) */
  timeoutMs?: number;
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
  /** Override per-provider timeout for this call */
  timeoutMs?: number;
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
  timeoutMs?: number;
  metadata?: Record<string, string>;
}

export interface RouterSendResult {
  ok: boolean;
  phone: NormalizedPhone;
  usedProvider?: string;
  usedChannel?: Channel;
  messageId?: string;
  attempts: ProviderAttemptResult[];
  skippedProviders: Array<{ provider: string; reason: string }>;
}
