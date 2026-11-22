import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MessageRouter,
  RedisBreakerStore,
  SendchampProvider,
  TwilioProvider,
  type RedisLikeClient,
} from "../src/index.js";

describe("Sendchamp & Twilio providers + RedisBreakerStore", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails over from Sendchamp to Twilio and persists breaker state in RedisBreakerStore", async () => {
    const kv = new Map<string, string>();
    const fakeRedis: RedisLikeClient = {
      get: async (k) => kv.get(k) ?? null,
      set: async (k, v) => {
        kv.set(k, v);
        return "OK";
      },
      del: async (k) => kv.delete(k),
    };

    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "error", message: "Insufficient wallet balance" }), {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sid: "SM1234567890", status: "queued" }), { status: 201 }),
      );

    const router = new MessageRouter({
      providers: [
        new SendchampProvider({ publicKey: "sc-key", senderName: "MyApp" }),
        new TwilioProvider({ accountSid: "AC123", authToken: "tok", from: "+15550001111" }),
      ],
      circuitBreaker: {
        failureThreshold: 1,
        cooldownMs: 60_000,
        store: new RedisBreakerStore(fakeRedis),
      },
    });

    const result = await router.sendOTP({ to: "08031234567", code: "123456" });

    expect(result.ok).toBe(true);
    expect(result.usedProvider).toBe("twilio");
    expect(result.messageId).toBe("SM1234567890");
    expect(result.attempts[0]?.errorCode).toBe("INSUFFICIENT_BALANCE");

    // Breaker state persisted under Redis key for sendchamp:MTN
    const stored = kv.get("afro-relay:cb:sendchamp:MTN");
    expect(stored).toBeDefined();
    expect(JSON.parse(stored!).failures).toBe(1);
  });

  it("parses Sendchamp and Twilio delivery webhooks", async () => {
    const router = new MessageRouter({
      providers: [
        new SendchampProvider({ publicKey: "sc-key", senderName: "MyApp" }),
        new TwilioProvider({ accountSid: "AC123", authToken: "tok", from: "+15550001111" }),
      ],
    });

    const scEvent = await router.handleWebhook("sendchamp", {
      data: { id: "sc-1", status: "delivered", phone_number: "2348031234567" },
    });
    expect(scEvent?.status).toBe("DELIVERED");
    expect(scEvent?.to?.telco).toBe("MTN");

    const twEvent = await router.handleWebhook("twilio", {
      MessageSid: "SM999",
      MessageStatus: "undelivered",
      To: "+2348021234567",
      ErrorMessage: "Carrier violation",
    });
    expect(twEvent?.status).toBe("FAILED");
    expect(twEvent?.to?.telco).toBe("AIRTEL");
  });
});
