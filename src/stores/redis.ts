import type { BreakerState, CircuitBreakerStore } from "../types.js";

/**
 * Minimal structural Redis client interface compatible with ioredis, node-redis,
 * and @upstash/redis without adding any runtime dependency.
 */
export interface RedisLikeClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export interface RedisBreakerStoreOptions {
  /** Key prefix in Redis (default: "afro-relay:cb:") */
  prefix?: string;
  /** Optional TTL in seconds for stored breaker entries (default: 3600) */
  ttlSeconds?: number;
}

export class RedisBreakerStore implements CircuitBreakerStore {
  private readonly client: RedisLikeClient;
  private readonly prefix: string;
  private readonly ttlSeconds: number;

  constructor(client: RedisLikeClient, options: RedisBreakerStoreOptions = {}) {
    this.client = client;
    this.prefix = options.prefix ?? "afro-relay:cb:";
    this.ttlSeconds = options.ttlSeconds ?? 3600;
  }

  private fullKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  async get(key: string): Promise<BreakerState | null> {
    const raw = await this.client.get(this.fullKey(key));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as BreakerState;
      if (typeof parsed.failures === "number") {
        return {
          failures: parsed.failures,
          openUntil: typeof parsed.openUntil === "number" ? parsed.openUntil : null,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  async set(key: string, state: BreakerState): Promise<void> {
    const serialized = JSON.stringify(state);
    if (this.ttlSeconds > 0) {
      await this.client.set(this.fullKey(key), serialized, "EX", this.ttlSeconds);
    } else {
      await this.client.set(this.fullKey(key), serialized);
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.del(this.fullKey(key));
  }
}
