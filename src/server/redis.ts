import Redis from "ioredis";

type Awaitable<T> = T | Promise<T>;

type AuthSecondaryStorage = {
  get(key: string): Awaitable<unknown>;
  getAndDelete(key: string): Awaitable<unknown>;
  increment(key: string, ttl: number): Awaitable<number>;
  set(key: string, value: string, ttl?: number): Awaitable<unknown>;
  delete(key: string): Awaitable<void>;
};

let redis: Redis | undefined;

export function getRedis(): Redis {
  if (redis) return redis;

  const url = process.env.REDIS_URL?.trim();
  if (!url) throw new Error("Redis is not configured");

  redis = new Redis(url, {
    lazyConnect: true,
    enableReadyCheck: true,
    maxRetriesPerRequest: 2,
    connectTimeout: 10_000,
  });
  // IORedis otherwise treats a connection error without a listener as an
  // uncaught event. Callers still receive the rejected operation.
  redis.on("error", () => undefined);
  return redis;
}

function prefixed(key: string): string {
  return `uno:auth:${key}`;
}

export function createRedisSecondaryStorage(client: Redis = getRedis()): AuthSecondaryStorage {
  return {
    get: (key) => client.get(prefixed(key)),
    async getAndDelete(key) {
      return client.eval(
        "local value = redis.call('GET', KEYS[1]); if value then redis.call('DEL', KEYS[1]); end; return value",
        1,
        prefixed(key),
      );
    },
    async increment(key, ttl) {
      const value = await client.eval(
        "local value = redis.call('INCR', KEYS[1]); if value == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; return value",
        1,
        prefixed(key),
        Math.max(1, Math.ceil(ttl)),
      );
      return Number(value);
    },
    async set(key, value, ttl) {
      if (ttl && ttl > 0) return client.set(prefixed(key), value, "EX", Math.ceil(ttl));
      return client.set(prefixed(key), value);
    },
    async delete(key) {
      await client.del(prefixed(key));
    },
  };
}

export function authSecondaryStorage(): AuthSecondaryStorage | undefined {
  const configured = Boolean(process.env.REDIS_URL?.trim());
  if (!configured && process.env.NODE_ENV === "production") {
    throw new Error("Redis is required for production authentication rate limiting");
  }
  return configured ? createRedisSecondaryStorage() : undefined;
}

export async function closeRedis(): Promise<void> {
  if (!redis) return;
  redis.disconnect(false);
  redis = undefined;
}

export type { AuthSecondaryStorage };
