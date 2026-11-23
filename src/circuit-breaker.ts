import type {
  BreakerScope,
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
  private readonly windowSize: number | null;
  private readonly failureRateThreshold: number;
  private readonly store: CircuitBreakerStore;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 10 * 60 * 1000;
    this.windowSize =
      options.windowSize && options.windowSize > 0 ? options.windowSize : null;
    this.failureRateThreshold = options.failureRateThreshold ?? 0.5;
    this.store = options.store ?? new MemoryBreakerStore();
  }

  static makeKey(scope: BreakerScope): string;
  static makeKey(provider: string, telco: string): string;
  static makeKey(scopeOrProvider: BreakerScope | string, telco?: string): string {
    if (typeof scopeOrProvider === "string") {
      return `${scopeOrProvider}:${telco ?? "UNKNOWN"}`;
    }
    const parts = [
      scopeOrProvider.provider,
      scopeOrProvider.country ?? "*",
      scopeOrProvider.telco,
    ];
    if (scopeOrProvider.senderId) {
      parts.push(scopeOrProvider.senderId);
    }
    if (scopeOrProvider.signal) {
      parts.push(scopeOrProvider.signal);
    }
    return parts.join(":");
  }

  private resolveKey(scopeOrProvider: BreakerScope | string, telco?: string): string {
    return typeof scopeOrProvider === "string"
      ? TelcoCircuitBreaker.makeKey(scopeOrProvider, telco ?? "UNKNOWN")
      : TelcoCircuitBreaker.makeKey(scopeOrProvider);
  }

  async isOpen(scope: BreakerScope, now?: number): Promise<boolean>;
  async isOpen(provider: string, telco: string, now?: number): Promise<boolean>;
  async isOpen(
    scopeOrProvider: BreakerScope | string,
    telcoOrNow?: string | number,
    maybeNow?: number,
  ): Promise<boolean> {
    const isScope = typeof scopeOrProvider !== "string";
    const key = isScope
      ? this.resolveKey(scopeOrProvider)
      : this.resolveKey(scopeOrProvider, telcoOrNow as string);
    const now = isScope ? ((telcoOrNow as number | undefined) ?? Date.now()) : (maybeNow ?? Date.now());

    const state = await this.store.get(key);
    if (!state || state.openUntil === null) return false;

    if (now >= state.openUntil) {
      // Half-open: cooldown elapsed, allow a probe request
      await this.store.set(key, { failures: 0, openUntil: null });
      return false;
    }

    return true;
  }

  async recordSuccess(scope: BreakerScope): Promise<void>;
  async recordSuccess(provider: string, telco: string): Promise<void>;
  async recordSuccess(scopeOrProvider: BreakerScope | string, telco?: string): Promise<void> {
    const key = this.resolveKey(scopeOrProvider, telco);

    if (this.windowSize !== null) {
      const current = await this.store.get(key);
      if (!current) return;
      const window = [...(current.window ?? []), 1].slice(-this.windowSize);
      const failures = window.filter((v) => v === 0).length;
      if (failures === 0) {
        await this.store.delete(key);
      } else {
        await this.store.set(key, { failures, openUntil: null, window });
      }
      return;
    }

    await this.store.delete(key);
  }

  async recordFailure(scope: BreakerScope, now?: number): Promise<BreakerState>;
  async recordFailure(provider: string, telco: string, now?: number): Promise<BreakerState>;
  async recordFailure(
    scopeOrProvider: BreakerScope | string,
    telcoOrNow?: string | number,
    maybeNow?: number,
  ): Promise<BreakerState> {
    const isScope = typeof scopeOrProvider !== "string";
    const key = isScope
      ? this.resolveKey(scopeOrProvider)
      : this.resolveKey(scopeOrProvider, telcoOrNow as string);
    const now = isScope ? ((telcoOrNow as number | undefined) ?? Date.now()) : (maybeNow ?? Date.now());

    const current = (await this.store.get(key)) ?? { failures: 0, openUntil: null };

    if (this.windowSize !== null) {
      const window = [...(current.window ?? []), 0].slice(-this.windowSize);
      const failures = window.filter((v) => v === 0).length;
      const failureRate = failures / window.length;
      const shouldOpen =
        failures >= this.failureThreshold && failureRate >= this.failureRateThreshold;
      const next: BreakerState = {
        failures,
        openUntil: shouldOpen ? now + this.cooldownMs : null,
        window,
      };
      await this.store.set(key, next);
      return next;
    }

    const failures = current.failures + 1;
    const openUntil = failures >= this.failureThreshold ? now + this.cooldownMs : null;
    const next: BreakerState = { failures, openUntil };
    await this.store.set(key, next);
    return next;
  }
}
