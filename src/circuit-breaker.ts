import type {
  BreakerState,
  CircuitBreakerOptions,
  CircuitBreakerStore,
} from "./types.js";

export class MemoryBreakerStore implements CircuitBreakerStore {
  private readonly map = new Map<string, BreakerState>();

  get(key: string): BreakerState | null {
    return this.map.get(key) ?? null;
  }

  set(key: string, state: BreakerState): void {
    this.map.set(key, state);
  }

  delete(key: string): void {
    this.map.delete(key);
  }
}

export class TelcoCircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly store: CircuitBreakerStore;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 10 * 60 * 1000;
    this.store = options.store ?? new MemoryBreakerStore();
  }

  static makeKey(provider: string, telco: string): string {
    return `${provider}:${telco}`;
  }

  async isOpen(provider: string, telco: string, now = Date.now()): Promise<boolean> {
    const key = TelcoCircuitBreaker.makeKey(provider, telco);
    const state = await this.store.get(key);
    if (!state || state.openUntil === null) return false;

    if (now >= state.openUntil) {
      // Half-open: cooldown elapsed, allow a probe request
      await this.store.set(key, { failures: 0, openUntil: null });
      return false;
    }

    return true;
  }

  async recordSuccess(provider: string, telco: string): Promise<void> {
    const key = TelcoCircuitBreaker.makeKey(provider, telco);
    await this.store.delete(key);
  }

  async recordFailure(provider: string, telco: string, now = Date.now()): Promise<BreakerState> {
    const key = TelcoCircuitBreaker.makeKey(provider, telco);
    const current = (await this.store.get(key)) ?? { failures: 0, openUntil: null };
    const failures = current.failures + 1;
    const openUntil = failures >= this.failureThreshold ? now + this.cooldownMs : null;
    const next: BreakerState = { failures, openUntil };
    await this.store.set(key, next);
    return next;
  }
}
