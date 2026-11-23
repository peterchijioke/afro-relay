import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AfricasTalkingProvider,
  MessageRouter,
  TermiiProvider,
  WhatsAppProvider,
} from "../src/index.js";

describe("MessageRouter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails over from Termii to Africa's Talking when Termii has insufficient balance", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "Insufficient balance" }), { status: 400 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            SMSMessageData: {
              Recipients: [
                {
                  statusCode: 101,
                  number: "+2348031234567",
                  status: "Success",
                  messageId: "ATXid_123",
                },
              ],
            },
          }),
          { status: 201 },
        ),
      );

    const router = new MessageRouter({
      providers: [
        new TermiiProvider({ apiKey: "t-key", senderId: "MyApp" }),
        new AfricasTalkingProvider({ apiKey: "at-key", username: "myapp" }),
      ],
    });

    const result = await router.sendOTP({ to: "0803 123 4567", code: "482910" });

    expect(result.ok).toBe(true);
    expect(result.usedProvider).toBe("africas-talking");
    expect(result.messageId).toBe("ATXid_123");
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]?.errorCode).toBe("INSUFFICIENT_BALANCE");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("escalates from SMS to WhatsApp when all SMS providers fail", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "DND rejected" }), { status: 400 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [{ id: "wamid.xyz" }] }), { status: 200 }),
      );

    const router = new MessageRouter({
      providers: [
        new TermiiProvider({ apiKey: "t-key", senderId: "MyApp" }),
        new WhatsAppProvider({
          phoneNumberId: "12345",
          accessToken: "wa-token",
          otpTemplateName: "otp_auth",
        }),
      ],
    });

    const result = await router.sendOTP({
      to: "08031234567",
      code: "991122",
      fallbackChannels: ["sms", "whatsapp"],
    });

    expect(result.ok).toBe(true);
    expect(result.usedProvider).toBe("whatsapp");
    expect(result.usedChannel).toBe("whatsapp");
    expect(result.messageId).toBe("wamid.xyz");
  });

  it("stops immediately on non-retryable INVALID_NUMBER", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "Invalid phone number" }), { status: 400 }),
    );

    const router = new MessageRouter({
      providers: [
        new TermiiProvider({ apiKey: "t-key", senderId: "MyApp" }),
        new AfricasTalkingProvider({ apiKey: "at-key", username: "myapp" }),
      ],
    });

    const result = await router.send({ to: "08031234567", text: "Hello" });

    expect(result.ok).toBe(false);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.errorCode).toBe("INVALID_NUMBER");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("skips Termii for MTN after circuit trips, while still using Termii for Airtel", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      // 1st MTN attempt: Termii 500 -> AT succeeds
      .mockResolvedValueOnce(new Response("down", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            SMSMessageData: {
              Recipients: [{ statusCode: 101, number: "+2348031234567", status: "Success", messageId: "at-1" }],
            },
          }),
          { status: 201 },
        ),
      )
      // 2nd MTN attempt: Termii skipped! Directly calls AT
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            SMSMessageData: {
              Recipients: [{ statusCode: 101, number: "+2348031234567", status: "Success", messageId: "at-2" }],
            },
          }),
          { status: 201 },
        ),
      )
      // Airtel attempt: Termii is NOT open for Airtel, so Termii succeeds
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "ok", message_id: "termii-airtel-1" }), { status: 200 }),
      );

    const router = new MessageRouter({
      providers: [
        new TermiiProvider({ apiKey: "t-key", senderId: "MyApp" }),
        new AfricasTalkingProvider({ apiKey: "at-key", username: "myapp" }),
      ],
      circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 },
    });

    const firstMtn = await router.send({ to: "08031234567", text: "Hi 1" });
    expect(firstMtn.usedProvider).toBe("africas-talking");

    const secondMtn = await router.send({ to: "08031234567", text: "Hi 2" });
    expect(secondMtn.usedProvider).toBe("africas-talking");
    expect(secondMtn.skippedProviders).toEqual([
      { provider: "termii", reason: "circuit_open:termii:NG:MTN:MyApp:submit" },
    ]);

    const airtel = await router.send({ to: "08021234567", text: "Hi Airtel" });
    expect(airtel.usedProvider).toBe("termii");
    expect(airtel.messageId).toBe("termii-airtel-1");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("feeds FAILED delivery webhooks into the delivery circuit without HTTP 200 resetting it", async () => {
    const router = new MessageRouter({
      providers: [
        new TermiiProvider({ apiKey: "t-key", senderId: "MyApp" }),
        new AfricasTalkingProvider({ apiKey: "at-key", username: "myapp" }),
      ],
      circuitBreaker: { failureThreshold: 2, cooldownMs: 60_000 },
    });

    // 1st delivery failure webhook
    const ev1 = await router.handleWebhook("termii", {
      message_id: "tm-1",
      status: "Message Failed",
      receiver: "2348031234567",
    });
    expect(ev1?.status).toBe("FAILED");

    // Meanwhile a new send() returns HTTP 200 OK (gateway ACCEPTED, not delivered).
    // This MUST NOT wipe out the delivery failure count!
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "ok", message_id: "tm-2" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            SMSMessageData: {
              Recipients: [{ statusCode: 101, number: "+2348031234567", status: "Success", messageId: "at-3" }],
            },
          }),
          { status: 201 },
        ),
      );

    const accepted = await router.send({ to: "08031234567", text: "OTP 1234" });
    expect(accepted.usedProvider).toBe("termii");

    // 2nd delivery failure webhook now crosses failureThreshold=2 and opens delivery circuit
    const ev2 = await router.handleWebhook("termii", {
      message_id: "tm-2",
      status: "Message Failed",
      receiver: "2348031234567",
    });
    expect(ev2?.status).toBe("FAILED");

    // Next MTN send must skip Termii due to open delivery circuit
    const res = await router.send({ to: "08031234567", text: "OTP 5678" });
    expect(res.usedProvider).toBe("africas-talking");
    expect(res.skippedProviders).toEqual([
      { provider: "termii", reason: "circuit_open:termii:NG:MTN:MyApp:delivery" },
    ]);
  });

  it("does not trip the telco circuit breaker on DND_REJECTED webhooks or DND_BLOCKED sends", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      // 1st send: Termii (generic) returns DND -> skips non-DND AT -> escalates to WhatsApp
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "DND rejected" }), { status: 400 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [{ id: "wamid.dnd1" }] }), { status: 200 }),
      )
      // 2nd send: Termii is NOT tripped, so it is still attempted for the next MTN user
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "ok", message_id: "tm-ok" }), { status: 200 }),
      );

    const router = new MessageRouter({
      providers: [
        new TermiiProvider({ apiKey: "t-key", senderId: "MyApp", channel: "generic" }),
        new AfricasTalkingProvider({ apiKey: "at-key", username: "myapp" }),
        new WhatsAppProvider({
          phoneNumberId: "12345",
          accessToken: "wa-token",
          otpTemplateName: "otp_auth",
        }),
      ],
      circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 },
    });

    // DND webhook should be parsed & returned, but must NOT trip Termii's MTN circuit
    const dndEvent = await router.handleWebhook("termii", {
      message_id: "tm-dnd",
      status: "DND Rejected",
      receiver: "2348031234567",
    });
    expect(dndEvent?.status).toBe("DND_REJECTED");

    const first = await router.sendOTP({
      to: "08031234567",
      code: "111222",
      fallbackChannels: ["sms", "whatsapp"],
    });
    expect(first.ok).toBe(true);
    expect(first.usedProvider).toBe("whatsapp");
    expect(first.skippedProviders).toEqual([
      { provider: "africas-talking", reason: "dnd_escalated" },
    ]);

    const second = await router.send({ to: "08039998888", text: "Hello" });
    expect(second.ok).toBe(true);
    expect(second.usedProvider).toBe("termii");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("prevents duplicate OTPs on TIMEOUT by default, and allows opt-in failoverOnTimeout", async () => {
    const timeoutErr = new Error("The operation was aborted due to timeout");
    timeoutErr.name = "TimeoutError";

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(timeoutErr)
      .mockRejectedValueOnce(timeoutErr)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            SMSMessageData: {
              Recipients: [{ statusCode: 101, number: "+2348031234567", status: "Success", messageId: "at-optin" }],
            },
          }),
          { status: 201 },
        ),
      );

    const router = new MessageRouter({
      providers: [
        new TermiiProvider({ apiKey: "t-key", senderId: "MyApp" }),
        new AfricasTalkingProvider({ apiKey: "at-key", username: "myapp" }),
      ],
      circuitBreaker: false,
    });

    // Default (failoverOnTimeout: false): stops after timeout with maybeSent: true
    const safeResult = await router.sendOTP({ to: "08031234567", code: "482910" });
    expect(safeResult.ok).toBe(false);
    expect(safeResult.maybeSent).toBe(true);
    expect(safeResult.attempts).toHaveLength(1);
    expect(safeResult.attempts[0]?.errorCode).toBe("TIMEOUT");
    expect(safeResult.attempts[0]?.maybeSent).toBe(true);

    // Opt-in (failoverOnTimeout: true): fails over and still flags maybeSent: true
    const aggressiveResult = await router.sendOTP({
      to: "08031234567",
      code: "482910",
      failoverOnTimeout: true,
    });
    expect(aggressiveResult.ok).toBe(true);
    expect(aggressiveResult.usedProvider).toBe("africas-talking");
    expect(aggressiveResult.maybeSent).toBe(true);
    expect(aggressiveResult.attempts).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("isolates MTN Nigeria from MTN Ghana and trips provider-global circuit on INSUFFICIENT_BALANCE", async () => {
    vi.spyOn(globalThis, "fetch")
      // MTN NG fails on Termii (500) -> AT succeeds
      .mockResolvedValueOnce(new Response("down", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            SMSMessageData: {
              Recipients: [{ statusCode: 101, number: "+2348031234567", status: "Success", messageId: "at-ng" }],
            },
          }),
          { status: 201 },
        ),
      )
      // MTN GH should still hit Termii because only NG:MTN tripped
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "ok", message_id: "tm-gh" }), { status: 200 }),
      )
      // Now Termii returns INSUFFICIENT_BALANCE on Airtel NG -> AT succeeds
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "Insufficient balance" }), { status: 400 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            SMSMessageData: {
              Recipients: [{ statusCode: 101, number: "+2348021234567", status: "Success", messageId: "at-airtel" }],
            },
          }),
          { status: 201 },
        ),
      )
      // Next Glo NG send skips Termii globally without wasting another call
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            SMSMessageData: {
              Recipients: [{ statusCode: 101, number: "+2348051234567", status: "Success", messageId: "at-glo" }],
            },
          }),
          { status: 201 },
        ),
      );

    const router = new MessageRouter({
      providers: [
        new TermiiProvider({ apiKey: "t-key", senderId: "MyApp" }),
        new AfricasTalkingProvider({ apiKey: "at-key", username: "myapp" }),
      ],
      circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 },
    });

    await router.send({ to: "+2348031234567", text: "MTN NG" });

    const mtnGh = await router.send({ to: "+233241234567", text: "MTN GH" });
    expect(mtnGh.usedProvider).toBe("termii");
    expect(mtnGh.messageId).toBe("tm-gh");

    await router.send({ to: "+2348021234567", text: "Airtel NG" });

    const gloNg = await router.send({ to: "+2348051234567", text: "Glo NG" });
    expect(gloNg.usedProvider).toBe("africas-talking");
    expect(gloNg.skippedProviders).toEqual([
      { provider: "termii", reason: "circuit_open:termii:*:*:submit" },
    ]);
  });
});
