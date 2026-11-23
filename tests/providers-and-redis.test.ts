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

    // INSUFFICIENT_BALANCE is a provider-global submit error persisted under sendchamp:*:*:submit
    const stored = kv.get("afro-relay:cb:sendchamp:*:*:submit");
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
    expect(scEvent?.isTerminal).toBe(true);
    expect(scEvent?.to?.telco).toBe("MTN");

    // "undelivered" and "delivery failed" must NOT be misclassified as DELIVERED
    const scUndelivered = await router.handleWebhook("sendchamp", {
      data: { id: "sc-2", status: "undelivered", phone_number: "2348031234567" },
    });
    expect(scUndelivered?.status).toBe("FAILED");
    expect(scUndelivered?.isTerminal).toBe(true);

    // "sent" is gateway/carrier acceptance (non-terminal), NOT handset delivery
    const scSent = await router.handleWebhook("sendchamp", {
      data: { id: "sc-3", status: "sent", phone_number: "2348031234567" },
    });
    expect(scSent?.status).toBe("ACCEPTED");
    expect(scSent?.isTerminal).toBe(false);

    const twEvent = await router.handleWebhook("twilio", {
      MessageSid: "SM999",
      MessageStatus: "undelivered",
      To: "+2348021234567",
      ErrorMessage: "Carrier violation",
    });
    expect(twEvent?.status).toBe("FAILED");
    expect(twEvent?.isTerminal).toBe(true);
    expect(twEvent?.to?.telco).toBe("AIRTEL");
  });

  it("uses node-redis setEx when available and fails open when all circuits are open", async () => {
    const setExCalls: Array<[string, number, string]> = [];
    const kv = new Map<string, string>();
    const nodeRedisClient: RedisLikeClient = {
      get: async (k) => kv.get(k) ?? null,
      set: async (k, v) => {
        kv.set(k, v);
        return "OK";
      },
      setEx: async (k, ttl, v) => {
        setExCalls.push([k, ttl, v]);
        kv.set(k, v);
        return "OK";
      },
      del: async (k) => kv.delete(k),
    };

    vi.spyOn(globalThis, "fetch")
      // First call fails and opens the only provider's circuit
      .mockResolvedValueOnce(new Response("down", { status: 500 }))
      // Second call: circuit is open, but since ALL providers are open, router probes it and recovers!
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "success", data: { id: "sc-recovered" } }), {
          status: 200,
        }),
      );

    const router = new MessageRouter({
      providers: [new SendchampProvider({ publicKey: "sc-key", senderName: "MyApp" })],
      circuitBreaker: {
        failureThreshold: 1,
        cooldownMs: 60_000,
        store: new RedisBreakerStore(nodeRedisClient, { ttlSeconds: 120 }),
      },
    });

    const first = await router.send({ to: "08031234567", text: "Hello" });
    expect(first.ok).toBe(false);
    expect(setExCalls).toHaveLength(1);
    expect(setExCalls[0]?.[1]).toBe(120);

    const second = await router.send({ to: "08031234567", text: "Hello again" });
    expect(second.ok).toBe(true);
    expect(second.messageId).toBe("sc-recovered");
    expect(second.skippedProviders).toHaveLength(1);
  });
});
