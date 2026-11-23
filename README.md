# afro-relay

[![npm version](https://img.shields.io/npm/v/afro-relay.svg)](https://www.npmjs.com/package/afro-relay)
[![CI](https://github.com/peterchijioke/afro-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/peterchijioke/afro-relay/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Zero-dependency multi-provider **SMS & OTP failover router** with **telco-aware circuit breaking** for African messaging APIs (**Termii**, **Sendchamp**, **Africa's Talking**, **Twilio**, **Meta WhatsApp Cloud API**).

## Why?

If you ship apps in Nigeria, Kenya, or Ghana, you already know:
- **DND silently drops OTPs** on generic routes.
- **Per-telco outages happen** — Termii's MTN route can fail for an hour while Airtel still delivers fine.
- **Hanging requests block logins** when a gateway takes 25s to time out.
- **Providers expect different phone formats** (`234803...` vs `+234803...`).

`afro-relay` sits in front of your existing provider keys so OTPs keep landing even when one provider or telco route goes down.

## Install

```bash
npm install afro-relay
```

Requires **Node.js 18+** (uses native `fetch` and `AbortSignal.timeout`).

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
  // Safe default: do not double-send an OTP on ambiguous HTTP timeouts
  failoverOnTimeout: false,
  circuitBreaker: {
    failureThreshold: 5,
    cooldownMs: 10 * 60 * 1000, // 10 minutes
    // Optional sliding-window failure rate (e.g. trip at >= 50% failures over last 20 attempts)
    windowSize: 20,
    failureRateThreshold: 0.5,
  },
});

const result = await router.sendOTP({
  to: "0803 123 4567",
  code: "482910",
  fallbackChannels: ["sms", "whatsapp"],
});

console.log(result.ok, result.usedProvider, result.messageId, result.maybeSent);
```

## How Signal-Aware Failover Works

Not all messaging failures mean the same thing. `afro-relay` separates them instead of treating every error as "the gateway is down":

| Signal | What `afro-relay` does |
| --- | --- |
| **Per-route outage** (`5xx`, `RATE_LIMITED`, `INVALID_SENDER_ID`, `FAILED` / `EXPIRED` DLR) | Trips only `(provider, country, telco, senderId)` — MTN Nigeria issues never block Airtel Nigeria, MTN Ghana, or another Sender ID. |
| **Submit vs. Delivery health** | HTTP `200 OK` only proves gateway acceptance, not telco delivery. Submit successes **never** reset `FAILED` delivery-receipt counters; only a `DELIVERED` webhook clears delivery health. |
| **DND (`DND_BLOCKED` / `DND_REJECTED`)** | Treated as a recipient/route signal, **never** trips the telco outage breaker. On `DND_BLOCKED`, skips other non-DND SMS providers and escalates to a DND-capable SMS route or the next channel (e.g. WhatsApp). |
| **Ambiguous `TIMEOUT`** | Records a submit failure and sets `maybeSent: true`. Stops by default (`failoverOnTimeout: false`) so you don't put a second OTP on the wire while the first gateway is still delivering. Set `failoverOnTimeout: true` if you want to prioritize latency (and reuse the same OTP code). |
| **Provider-wide errors** (`AUTH_ERROR`, `INSUFFICIENT_BALANCE`) | Trips `(provider, *, *)` globally so you don't waste retries across every telco on an unfunded or misconfigured account. |
| **Hard recipient errors** (`INVALID_NUMBER`) | Stops immediately without retrying or tripping any breaker. |

> **Ported numbers (MNP):** Prefix detection is best-effort. If you run HLR/MNP lookups, pass `telco: "AIRTEL"` on `send()` or `sendOTP()` to override prefix detection.

## Feed Delivery Webhooks Back into the Circuit Breaker

SMS providers often return `200 OK` even when the telco drops the message seconds later. Pass incoming delivery receipts to `handleWebhook` so repeated `FAILED` or `EXPIRED` receipts trip the **delivery** circuit breaker for that `(provider, country, telco, senderId)` route automatically (while `DND_REJECTED` is returned for your app to handle without tripping the telco outage breaker):

```ts
app.post("/webhooks/termii", async (req, res) => {
  // Always verify the provider's webhook signature or IP allowlist first
  // so untrusted callers cannot spoof FAILED receipts to trip your circuit breaker.
  const event = await router.handleWebhook("termii", req.body, req.headers);
  // event = { provider: "termii", messageId: "...", status: "FAILED", isTerminal: true, to: { country: "NG", telco: "MTN", ... } }
  // Only trigger receipt-driven fallback on a terminal miss (never on intermediate ACCEPTED/PENDING events):
  if (event?.isTerminal && event.status !== "DELIVERED") {
    // Safe to resend the same OTP over a backup provider/channel
  }
  res.sendStatus(200);
});
```

Unified webhook statuses are strictly normalized across all providers:
- `ACCEPTED` / `PENDING` (`isTerminal: false`) — carrier/gateway accepted (`sent`, `queued`, `submitted`, `buffered`), **not** handset delivery.
- `DELIVERED` (`isTerminal: true`) — handset delivery confirmed.
- `FAILED` / `EXPIRED` / `DND_REJECTED` (`isTerminal: true`) — terminal miss; safe to escalate.

## Production Multi-Instance Circuit Breaker (Redis)

By default the circuit breaker uses in-memory storage. For multi-instance servers, pass any Redis client (`ioredis`, `node-redis`, `@upstash/redis`) to `RedisBreakerStore`:

```ts
import Redis from "ioredis";
import { MessageRouter, RedisBreakerStore, TermiiProvider, SendchampProvider } from "afro-relay";

const redis = new Redis(process.env.REDIS_URL!);

const router = new MessageRouter({
  providers: [
    new TermiiProvider({ apiKey: process.env.TERMII_API_KEY!, senderId: "MyApp" }),
    new SendchampProvider({ publicKey: process.env.SENDCHAMP_KEY!, senderName: "MyApp" }),
  ],
  circuitBreaker: {
    failureThreshold: 5,
    cooldownMs: 10 * 60 * 1000,
    store: new RedisBreakerStore(redis),
  },
});
```

## Custom Providers

Implement the small `MessagingProvider` interface to plug in Hubtel, Infobip, BulkSMS Nigeria, or any other gateway.

## License

MIT
