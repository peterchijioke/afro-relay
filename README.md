# afro-relay

[![npm version](https://img.shields.io/npm/v/afro-relay.svg)](https://www.npmjs.com/package/afro-relay)
[![CI](https://github.com/peterchijioke/afro-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/peterchijioke/afro-relay/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/peterchijioke/afro-relay/blob/master/LICENSE)

Zero-dependency multi-provider **SMS & OTP failover router** with **telco-aware circuit breaking** for African messaging APIs (**Termii**, **Sendchamp**, **Africa's Talking**, **Twilio**, and **Meta WhatsApp Cloud API**).

## Table of Contents

- [Why afro-relay?](#why-afro-relay)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [How Signal-Aware Failover Works](#how-signal-aware-failover-works)
- [API Reference](#api-reference)
  - [`new MessageRouter(options)`](#new-messagerouteroptions)
  - [`router.send(input)`](#routersendinput)
  - [`router.sendOTP(input)`](#routersendotpinput)
  - [`router.handleWebhook(providerName, body, headers?)`](#routerhandlewebhookprovidername-body-headers)
  - [`normalizePhone(raw, defaultCountry?)`](#normalizephoneraw-defaultcountry)
  - [`TelcoCircuitBreaker` & `RedisBreakerStore`](#telcocircuitbreaker--redisbreakerstore)
- [Built-in Providers](#built-in-providers)
- [Custom Providers](#custom-providers)
- [Security & Production Checklist](#security--production-checklist)
- [License](#license)

---

## Why afro-relay?

If you ship apps in Nigeria, Kenya, or Ghana, you already know:
- **DND silently drops OTPs** on generic routes.
- **Per-telco outages happen** — Termii's MTN route can fail for an hour while Airtel still delivers fine.
- **Hanging requests block logins** when a gateway takes 25s to time out.
- **Providers expect different phone formats** (`234803...` vs `+234803...`).

`afro-relay` sits in front of your existing provider keys so OTPs keep landing without punishing healthy routes or double-sending codes.

---

## Installation

```bash
npm install afro-relay
```

Requires **Node.js 18+** (uses native `fetch` and `AbortSignal.timeout`). Zero runtime dependencies.

---

## Quick Start

```ts
import {
  MessageRouter,
  TermiiProvider,
  AfricasTalkingProvider,
  WhatsAppProvider,
} from "afro-relay";

const router = new MessageRouter({
  providers: [
    new TermiiProvider({
      apiKey: process.env.TERMII_API_KEY!,
      senderId: "MyApp",
      channel: "dnd",
    }),
    new AfricasTalkingProvider({
      apiKey: process.env.AT_API_KEY!,
      username: process.env.AT_USERNAME!,
    }),
    new WhatsAppProvider({
      phoneNumberId: process.env.WA_PHONE_NUMBER_ID!,
      accessToken: process.env.WA_ACCESS_TOKEN!,
      otpTemplateName: "otp_verification",
    }),
  ],
  timeoutMs: 5000,
  failoverOnTimeout: false,
  circuitBreaker: {
    failureThreshold: 5,
    cooldownMs: 10 * 60 * 1000, // 10 minutes
    windowSize: 20,
    failureRateThreshold: 0.5,
  },
});

const result = await router.sendOTP({
  to: "0803 123 4567",
  code: "482910",
  fallbackChannels: ["sms", "whatsapp"],
});

if (result.ok) {
  console.log("Sent via:", result.usedProvider, result.messageId);
} else if (result.maybeSent) {
  console.warn("Timed out in an ambiguous state; reuse the same OTP on retry.");
}
```

---

## How Signal-Aware Failover Works

Not all messaging failures mean the same thing. `afro-relay` separates each signal instead of treating every error as "the gateway is down":

| Signal | Behavior |
| --- | --- |
| **Per-route outage** (`5xx`, `RATE_LIMITED`, `INVALID_SENDER_ID`, `FAILED` / `EXPIRED` DLR) | Trips only `(provider, country, telco, senderId)` — MTN Nigeria issues never block Airtel Nigeria, MTN Ghana, or another Sender ID. |
| **Submit vs. Delivery health** | HTTP `200 OK` only proves gateway acceptance, not handset delivery. Submit successes **never** reset `FAILED` delivery-receipt counters; only a `DELIVERED` webhook clears delivery health. |
| **DND (`DND_BLOCKED` / `DND_REJECTED`)** | Treated as a recipient/route signal and **never** trips the telco outage breaker. On `DND_BLOCKED`, skips non-DND SMS providers and escalates to a DND-capable SMS route or the next channel (e.g. WhatsApp). |
| **Ambiguous `TIMEOUT`** | Records a `submit` failure and sets `maybeSent: true`. Stops by default (`failoverOnTimeout: false`) so a backup provider does not put a second code on the wire while the first attempt is still open. |
| **Provider-wide errors** (`AUTH_ERROR`, `INSUFFICIENT_BALANCE`) | Trips `(provider, *, *)` globally so requests across every telco skip an unfunded or misconfigured account. |
| **Hard recipient errors** (`INVALID_NUMBER`) | Stops immediately without retrying or tripping any breaker. |

---

## API Reference

### `new MessageRouter(options)`

Creates a multi-provider failover router.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `providers` | `MessagingProvider[]` | *required* | Ordered list of providers to try within each channel. |
| `defaultCountry` | `"NG" \| "KE" \| "GH"` | `"NG"` | Default country used when normalizing local numbers like `"0803..."`. |
| `timeoutMs` | `number` | `5000` | Per-provider HTTP timeout in milliseconds. |
| `failoverOnTimeout` | `boolean` | `false` | If `false`, stops after an HTTP `TIMEOUT` and returns `maybeSent: true` to prevent duplicate OTPs. Set `true` to prioritize latency over duplicate-send risk. |
| `circuitBreaker` | `CircuitBreakerOptions \| false` | `{ failureThreshold: 5, cooldownMs: 600000 }` | Telco-aware circuit breaker config, or `false` to disable. |
| `onAttempt` | `(attempt, phone) => void` | `undefined` | Optional hook called after every provider attempt for structured logging or metrics. |

---

### `router.send(input)`

Sends a plain text or transactional message across the configured channels and providers.

```ts
const result = await router.send({
  to: "0803 123 4567",
  text: "Your transfer of NGN 5,000 was successful.",
  channels: ["sms"],
  country: "NG",
  timeoutMs: 5000,
});
```

#### Parameters (`SendMessageInput`)

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `to` | `string` | *required* | Recipient phone number in any local or international format (normalized to E.164 before the first send). |
| `text` | `string` | *required* | Message body. |
| `otpCode` | `string` | `undefined` | Optional OTP code (enables DND routes on Termii/Sendchamp and auth templates on WhatsApp). |
| `channels` | `("sms" \| "whatsapp" \| "voice")[]` | `["sms"]` | Ordered list of channels to try. |
| `country` | `"NG" \| "KE" \| "GH"` | `router.defaultCountry` | Overrides default country for local number parsing. |
| `telco` | `TelcoName` | *auto-detected* | Overrides prefix-based carrier detection (recommended if you have HLR/MNP portability lookups). |
| `timeoutMs` | `number` | `router.timeoutMs` | Overrides per-provider HTTP timeout for this call. |
| `failoverOnTimeout` | `boolean` | `router.failoverOnTimeout` | Overrides timeout failover policy for this call. |
| `metadata` | `Record<string, string>` | `undefined` | Optional key-value metadata passed to providers. |

#### Return Value (`Promise<RouterSendResult>`)

```ts
interface RouterSendResult {
  ok: boolean;
  phone: NormalizedPhone; // { e164, bare, country, telco }
  usedProvider?: string;
  usedChannel?: "sms" | "whatsapp" | "voice";
  messageId?: string;
  maybeSent?: boolean; // true if any attempt timed out ambiguously
  attempts: ProviderAttemptResult[];
  skippedProviders: Array<{ provider: string; reason: string }>;
}
```

---

### `router.sendOTP(input)`

Convenience wrapper around `router.send()` for one-time passcodes. `afro-relay` **never generates OTPs** — your app owns code generation/TTL and passes `code`, so every failover attempt reuses the exact same code.

```ts
const result = await router.sendOTP({
  to: "0803 123 4567",
  code: "482910",
  message: "Your MyApp code is {code}. Expires in 10 minutes.",
  fallbackChannels: ["sms", "whatsapp"],
});
```

#### Parameters (`SendOTPInput`)

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `to` | `string` | *required* | Recipient phone number. |
| `code` | `string` | *required* | OTP code generated by your application. |
| `message` | `string` | `"Your verification code is {code}."` | Custom message template; `{code}` is replaced with `code`. |
| `fallbackChannels` | `Channel[]` | `["sms", "whatsapp"]` | Ordered channels to try on failover. |
| `country` | `"NG" \| "KE" \| "GH"` | `router.defaultCountry` | Optional country override. |
| `telco` | `TelcoName` | *auto-detected* | Optional carrier override for ported numbers (MNP). |
| `timeoutMs` | `number` | `router.timeoutMs` | Optional per-provider HTTP timeout override. |
| `failoverOnTimeout` | `boolean` | `router.failoverOnTimeout` | Optional timeout failover override. |
| `metadata` | `Record<string, string>` | `undefined` | Optional metadata passed to providers. |

Returns `Promise<RouterSendResult>`.

---

### `router.handleWebhook(providerName, body, headers?)`

Parses an incoming delivery receipt (DLR) webhook from a registered provider and updates the **delivery** circuit breaker for that `(provider, country, telco, senderId)` route.

```ts
app.post("/webhooks/termii", async (req, res) => {
  // Always verify the provider's webhook signature or IP allowlist first.
  const event = await router.handleWebhook(
    "termii",
    req.body,
    req.headers,
  );

  // Trigger receipt-driven fallback ONLY on a terminal miss:
  if (event?.isTerminal && event.status !== "DELIVERED") {
    // Safe to resend the same active OTP via a backup provider/channel
  }

  res.sendStatus(200);
});
```

#### Parameters
- `providerName`: `string` — Name of the registered provider (`"termii"`, `"sendchamp"`, `"africas-talking"`, `"twilio"`, `"whatsapp"`, or your custom provider's `name`).
- `body`: `unknown` — Parsed JSON or form-encoded webhook request body.
- `headers`: `Record<string, string | undefined>` *(optional)* — Request headers passed through to `provider.parseWebhook`.

#### Return Value (`Promise<NormalizedWebhookEvent | null>`)

Returns `null` if the provider is not registered or the payload is not a recognizable delivery receipt. Otherwise returns:

```ts
interface NormalizedWebhookEvent {
  provider: string;
  messageId: string;
  status:
    | "ACCEPTED"
    | "PENDING"
    | "DELIVERED"
    | "FAILED"
    | "DND_REJECTED"
    | "EXPIRED";
  isTerminal: boolean;
  to?: NormalizedPhone;
  reason?: string;
  raw: unknown;
}
```

Status semantics across all providers:
- `ACCEPTED` / `PENDING` (`isTerminal: false`) — Gateway/carrier accepted (`sent`, `queued`, `submitted`, `buffered`). Still open; does not trip the breaker or trigger failover.
- `DELIVERED` (`isTerminal: true`) — Handset delivery confirmed; resets the delivery breaker for that route.
- `FAILED` / `EXPIRED` (`isTerminal: true`) — Terminal miss; increments the delivery breaker and is safe for receipt-driven fallback.
- `DND_REJECTED` (`isTerminal: true`) — Recipient DND block; returned to your app without tripping the telco outage breaker.

---

### `normalizePhone(raw, defaultCountry?)`

Normalizes messy local or international African phone numbers into E.164, bare digits, ISO-2 country code, and best-effort carrier name.

```ts
import { normalizePhone } from "afro-relay";

normalizePhone("0803 123 4567", "NG");
// {
//   e164: "+2348031234567",
//   bare: "2348031234567",
//   country: "NG",
//   telco: "MTN",
// }

normalizePhone("+254 712 345 678");
// {
//   e164: "+254712345678",
//   bare: "254712345678",
//   country: "KE",
//   telco: "SAFARICOM",
// }
```

- **Supported countries & detected carriers**:
  - **Nigeria (`NG`, `+234`)**: `MTN`, `AIRTEL`, `GLO`, `9MOBILE`
  - **Kenya (`KE`, `+254`)**: `SAFARICOM`, `AIRTEL`, `TELKOM`
  - **Ghana (`GH`, `+233`)**: `MTN`, `TELECEL`, `AIRTELTIGO`
  - Other valid international numbers return `country: "UNKNOWN", telco: "UNKNOWN"`.
- Throws an `Error` if the phone number has invalid length.

---

### `TelcoCircuitBreaker` & `RedisBreakerStore`

By default `MessageRouter` uses an in-memory `MemoryBreakerStore`. For multi-instance deployments, pass any Redis client (`ioredis`, `node-redis`, `@upstash/redis`) to `RedisBreakerStore`:

```ts
import Redis from "ioredis";
import {
  MessageRouter,
  RedisBreakerStore,
  TermiiProvider,
  SendchampProvider,
} from "afro-relay";

const redis = new Redis(process.env.REDIS_URL!);

const router = new MessageRouter({
  providers: [
    new TermiiProvider({
      apiKey: process.env.TERMII_API_KEY!,
      senderId: "MyApp",
    }),
    new SendchampProvider({
      publicKey: process.env.SENDCHAMP_KEY!,
      senderName: "MyApp",
    }),
  ],
  circuitBreaker: {
    failureThreshold: 5,
    cooldownMs: 10 * 60 * 1000,
    windowSize: 20,
    failureRateThreshold: 0.5,
    store: new RedisBreakerStore(redis, {
      prefix: "afro-relay:cb:",
      ttlSeconds: 3600,
    }),
  },
});
```

#### `CircuitBreakerOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `failureThreshold` | `number` | `5` | Consecutive failures (or failures within `windowSize`) required to open the circuit. |
| `cooldownMs` | `number` | `600000` | Duration in milliseconds the circuit stays open before allowing a half-open probe. |
| `windowSize` | `number` | `undefined` | Optional sliding window size. When set, one lucky success no longer wipes out prior failures. |
| `failureRateThreshold` | `number` | `0.5` | Minimum failure ratio (`0..1`) required to open when `windowSize` is enabled. |
| `store` | `CircuitBreakerStore` | `MemoryBreakerStore` | Storage backend (`MemoryBreakerStore`, `RedisBreakerStore`, or custom). |

#### `RedisBreakerStore` Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `prefix` | `string` | `"afro-relay:cb:"` | Redis key prefix. |
| `ttlSeconds` | `number` | `3600` | Key expiration TTL in seconds. |

---

## Built-in Providers

### `TermiiProvider`

```ts
import { TermiiProvider } from "afro-relay";

new TermiiProvider({
  apiKey: process.env.TERMII_API_KEY!,
  senderId: "MyApp",
  channel: "dnd", // optional: "dnd" | "generic" | "whatsapp"
  baseUrl: "https://v3.api.termii.com", // optional
});
```

### `SendchampProvider`

```ts
import { SendchampProvider } from "afro-relay";

new SendchampProvider({
  publicKey: process.env.SENDCHAMP_KEY!,
  senderName: "MyApp",
  route: "dnd", // optional: "dnd" | "non_dnd" | "international"
  baseUrl: "https://api.sendchamp.com/api/v1", // optional
});
```

### `AfricasTalkingProvider`

```ts
import { AfricasTalkingProvider } from "afro-relay";

new AfricasTalkingProvider({
  apiKey: process.env.AT_API_KEY!,
  username: process.env.AT_USERNAME!,
  from: "MyApp", // optional registered Sender ID / Shortcode
  sandbox: false, // optional: true for AT sandbox
});
```

### `TwilioProvider`

```ts
import { TwilioProvider } from "afro-relay";

new TwilioProvider({
  accountSid: process.env.TWILIO_ACCOUNT_SID!,
  authToken: process.env.TWILIO_AUTH_TOKEN!,
  from: "+15551234567", // E.164 number or MessagingServiceSid ("MG...")
  baseUrl: "https://api.twilio.com", // optional
});
```

### `WhatsAppProvider`

```ts
import { WhatsAppProvider } from "afro-relay";

new WhatsAppProvider({
  phoneNumberId: process.env.WA_PHONE_NUMBER_ID!,
  accessToken: process.env.WA_ACCESS_TOKEN!,
  otpTemplateName: "otp_verification", // optional Meta Auth template
  includeCopyCodeButton: false, // true only if template has a copy button
  languageCode: "en_US", // optional
  apiVersion: "v21.0", // optional
});
```

---

## Custom Providers

Implement the `MessagingProvider` interface to plug in Hubtel, Infobip, BulkSMS Nigeria, or any other gateway:

```ts
import type {
  MessagingProvider,
  ProviderAttemptResult,
  SendPayload,
} from "afro-relay";

export class MyGatewayProvider implements MessagingProvider {
  readonly name = "my-gateway";
  readonly channels = ["sms"] as const;
  readonly senderId = "MyApp";
  readonly dndCapable = true;

  async send(payload: SendPayload): Promise<ProviderAttemptResult> {
    const start = Date.now();
    try {
      const res = await fetch("https://api.example.com/sms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(payload.timeoutMs),
        body: JSON.stringify({
          to: payload.to.e164,
          from: this.senderId,
          message: payload.text,
        }),
      });
      const raw = await res.json();
      if (res.ok) {
        return {
          provider: this.name,
          channel: payload.channel,
          ok: true,
          messageId: raw.id,
          retryable: false,
          latencyMs: Date.now() - start,
          raw,
        };
      }
      return {
        provider: this.name,
        channel: payload.channel,
        ok: false,
        errorCode: "PROVIDER_UNAVAILABLE",
        errorMessage: raw.error ?? `HTTP ${res.status}`,
        retryable: true,
        latencyMs: Date.now() - start,
        raw,
      };
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === "TimeoutError";
      return {
        provider: this.name,
        channel: payload.channel,
        ok: false,
        errorCode: isTimeout ? "TIMEOUT" : "PROVIDER_UNAVAILABLE",
        errorMessage: err instanceof Error ? err.message : String(err),
        retryable: true,
        ...(isTimeout ? { maybeSent: true } : {}),
        latencyMs: Date.now() - start,
      };
    }
  }
}
```

---

## Security & Production Checklist

- **Verify webhook signatures before calling `handleWebhook()`**: Untrusted callers who can POST fake `FAILED` webhooks could trip your delivery circuit breakers. Verify provider signatures (`X-Twilio-Signature`, `X-Hub-Signature-256`, or provider IP allowlists) in your HTTP route before delegating to `router.handleWebhook()`.
- **Avoid logging `raw` payloads in plaintext**: `ProviderAttemptResult.raw` and `NormalizedWebhookEvent.raw` contain raw gateway responses (which may include phone numbers). Log structured fields (`provider`, `ok`, `errorCode`, `latencyMs`) instead.
- **Use `RedisBreakerStore` in multi-instance deployments**: The default `MemoryBreakerStore` is per-process.
- **Keep `baseUrl` server-configured**: Never pass user-supplied URLs into provider `baseUrl` options.

---

## License

This project is licensed under the **MIT License** — see the [LICENSE](./LICENSE) file for full details.

Copyright © 2026 [Peter Chukwu](https://github.com/peterchijioke) and contributors.
