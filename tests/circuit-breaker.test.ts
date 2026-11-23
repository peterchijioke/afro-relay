import { describe, expect, it } from "vitest";
import { TelcoCircuitBreaker } from "../src/circuit-breaker.js";

describe("TelcoCircuitBreaker", () => {
  it("trips only for the failing (provider, telco) pair and recovers after cooldown", async () => {
    const breaker = new TelcoCircuitBreaker({ failureThreshold: 2, cooldownMs: 10_000 });
    const t0 = 1_000_000;

    await breaker.recordFailure("termii", "MTN", t0);
    expect(await breaker.isOpen("termii", "MTN", t0)).toBe(false);

    await breaker.recordFailure("termii", "MTN", t0 + 100);
    expect(await breaker.isOpen("termii", "MTN", t0 + 200)).toBe(true);
    // Airtel on Termii must remain healthy
    expect(await breaker.isOpen("termii", "AIRTEL", t0 + 200)).toBe(false);

    // Recovers after cooldown
    expect(await breaker.isOpen("termii", "MTN", t0 + 10_100)).toBe(false);
  });

  it("resets failure count on success", async () => {
    const breaker = new TelcoCircuitBreaker({ failureThreshold: 2, cooldownMs: 10_000 });
    await breaker.recordFailure("termii", "MTN");
    await breaker.recordSuccess("termii", "MTN");
    await breaker.recordFailure("termii", "MTN");
    expect(await breaker.isOpen("termii", "MTN")).toBe(false);
  });

  it("isolates circuits by country, senderId, and submit vs delivery signal", async () => {
    const breaker = new TelcoCircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000 });
    const t0 = 1_000_000;

    await breaker.recordFailure(
      { provider: "termii", country: "NG", telco: "MTN", senderId: "AppA", signal: "delivery" },
      t0,
    );

    expect(
      await breaker.isOpen(
        { provider: "termii", country: "NG", telco: "MTN", senderId: "AppA", signal: "delivery" },
        t0 + 100,
      ),
    ).toBe(true);
    // Same telco in Ghana remains open/healthy
    expect(
      await breaker.isOpen(
        { provider: "termii", country: "GH", telco: "MTN", senderId: "AppA", signal: "delivery" },
        t0 + 100,
      ),
    ).toBe(false);
    // Different senderId on same telco remains healthy
    expect(
      await breaker.isOpen(
        { provider: "termii", country: "NG", telco: "MTN", senderId: "AppB", signal: "delivery" },
        t0 + 100,
      ),
    ).toBe(false);
    // Submit signal is isolated from delivery signal
    expect(
      await breaker.isOpen(
        { provider: "termii", country: "NG", telco: "MTN", senderId: "AppA", signal: "submit" },
        t0 + 100,
      ),
    ).toBe(false);
  });

  it("supports sliding-window failure rate so one lucky success does not hide an outage", async () => {
    const breaker = new TelcoCircuitBreaker({
      failureThreshold: 3,
      windowSize: 5,
      failureRateThreshold: 0.6,
      cooldownMs: 10_000,
    });
    const scope = { provider: "termii", country: "NG" as const, telco: "MTN" as const, signal: "delivery" as const };
    const t0 = 1_000_000;

    await breaker.recordFailure(scope, t0);
    await breaker.recordFailure(scope, t0 + 10);
    await breaker.recordSuccess(scope); // 1 success shouldn't wipe out 2 failures
    expect(await breaker.isOpen(scope, t0 + 20)).toBe(false);

    await breaker.recordFailure(scope, t0 + 30); // 3 failures out of 4 = 75% >= 60%
    expect(await breaker.isOpen(scope, t0 + 40)).toBe(true);
  });
});
