# afro-relay

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
  circuitBreaker: {
    failureThreshold: 5,
    cooldownMs: 10 * 60 * 1000, // 10 minutes
  },
});

const result = await router.sendOTP({
  to: "0803 123 4567",
  code: "482910",
  fallbackChannels: ["sms", "whatsapp"],
});

console.log(result.ok, result.usedProvider, result.messageId);
```

## Feed Delivery Webhooks Back into the Circuit Breaker

SMS providers often return `200 OK` even when the telco drops the message seconds later. Pass incoming delivery receipts to `handleWebhook` so repeated `DND_REJECTED` or `FAILED` receipts trip the circuit breaker for that `(provider, telco)` pair automatically:

```ts
app.post("/webhooks/termii", async (req, res) => {
  const event = await router.handleWebhook("termii", req.body, req.headers);
  // event = { provider: "termii", messageId: "...", status: "DND_REJECTED", to: { telco: "MTN", ... } }
  res.sendStatus(200);
});
```

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
