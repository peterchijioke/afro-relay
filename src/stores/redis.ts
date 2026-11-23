import type { BreakerState, CircuitBreakerStore } from "../types.js";

/**
 * Minimal structural Redis client interface compatible with ioredis, node-redis v4,
 * and @upstash/redis without adding any runtime dependency.
 */
export interface RedisLikeClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(key: string): Promise<unknown>;
  /** node-redis v4 style */
  setEx?(key: string, seconds: number, value: string): Promise<unknown>;
  /** ioredis style */
  setex?(key: string, seconds: number, value: string): Promise<unknown>;
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
        const state: BreakerState = {
          failures: parsed.failures,
          openUntil: typeof parsed.openUntil === "number" ? parsed.openUntil : null,
        };
        if (Array.isArray(parsed.window)) {
          state.window = parsed.window.filter((v): v is number => v === 0 || v === 1);
        }
        return state;
      }
      return null;
    } catch {
      return null;
    }
  }

  async set(key: string, state: BreakerState): Promise<void> {
    const k = this.fullKey(key);
    const serialized = JSON.stringify(state);
    if (this.ttlSeconds > 0) {
      if (typeof this.client.setEx === "function") {
        await this.client.setEx(k, this.ttlSeconds, serialized);
        return;
      }
      if (typeof this.client.setex === "function") {
        await this.client.setex(k, this.ttlSeconds, serialized);
        return;
      }
    }
    await this.client.set(k, serialized);
  }

  async delete(key: string): Promise<void> {
    await this.client.del(this.fullKey(key));
  }
}
