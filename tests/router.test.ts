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
      { provider: "termii", reason: "circuit_open:termii:MTN" },
    ]);

    const airtel = await router.send({ to: "08021234567", text: "Hi Airtel" });
    expect(airtel.usedProvider).toBe("termii");
    expect(airtel.messageId).toBe("termii-airtel-1");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("feeds failed delivery webhooks back into the circuit breaker", async () => {
    const router = new MessageRouter({
      providers: [
        new TermiiProvider({ apiKey: "t-key", senderId: "MyApp" }),
        new AfricasTalkingProvider({ apiKey: "at-key", username: "myapp" }),
      ],
      circuitBreaker: { failureThreshold: 1, cooldownMs: 60_000 },
    });

    const event = await router.handleWebhook("termii", {
      message_id: "tm-99",
      status: "DND Rejected",
      receiver: "2348031234567",
    });

    expect(event?.status).toBe("DND_REJECTED");

    // Next MTN send should now skip Termii automatically
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          SMSMessageData: {
            Recipients: [{ statusCode: 101, number: "+2348031234567", status: "Success", messageId: "at-3" }],
          },
        }),
        { status: 201 },
      ),
    );

    const res = await router.send({ to: "08031234567", text: "OTP 1234" });
    expect(res.usedProvider).toBe("africas-talking");
    expect(res.skippedProviders[0]?.provider).toBe("termii");
  });
});
