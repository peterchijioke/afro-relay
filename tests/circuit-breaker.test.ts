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
});
