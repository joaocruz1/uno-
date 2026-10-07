import type Redis from "ioredis";

import { AppError } from "@/lib/errors";
import { getRedis } from "@/server/redis";

export interface ApiCapacityStore {
  acquire(key: string, maxRequests: number, ttlSeconds: number): Promise<boolean>;
  addBytes(key: string, bytes: number, maxBytes: number, ttlSeconds: number): Promise<boolean>;
  release(key: string, bytes: number): Promise<void>;
}

class RedisApiCapacityStore implements ApiCapacityStore {
  constructor(private readonly redis: Redis) {}

  async acquire(key: string, maxRequests: number, ttlSeconds: number): Promise<boolean> {
    const result = await this.redis.eval(
      "local r=tonumber(redis.call('HGET',KEYS[1],'requests') or '0'); if r+1>tonumber(ARGV[1]) then return 0 end; redis.call('HINCRBY',KEYS[1],'requests',1); redis.call('EXPIRE',KEYS[1],ARGV[2]); return 1",
      1, key, maxRequests, ttlSeconds,
    );
    return Number(result) === 1;
  }

  async addBytes(key: string, bytes: number, maxBytes: number, ttlSeconds: number): Promise<boolean> {
    const result = await this.redis.eval(
      "local b=tonumber(redis.call('HGET',KEYS[1],'bytes') or '0'); if b+tonumber(ARGV[1])>tonumber(ARGV[2]) then return 0 end; redis.call('HINCRBY',KEYS[1],'bytes',ARGV[1]); redis.call('EXPIRE',KEYS[1],ARGV[3]); return 1",
      1, key, bytes, maxBytes, ttlSeconds,
    );
    return Number(result) === 1;
  }

  async release(key: string, bytes: number): Promise<void> {
    await this.redis.eval(
      "local r=math.max(0,tonumber(redis.call('HGET',KEYS[1],'requests') or '0')-1); local b=math.max(0,tonumber(redis.call('HGET',KEYS[1],'bytes') or '0')-tonumber(ARGV[1])); if r==0 and b==0 then redis.call('DEL',KEYS[1]) else redis.call('HSET',KEYS[1],'requests',r,'bytes',b) end; return 1",
      1, key, bytes,
    );
  }
}

export type ApiCapacityLease = {
  addBytes(bytes: number): Promise<void>;
  release(): Promise<void>;
};

export async function acquireApiCapacity(
  input: { organizationId: string; maxRequests: number; maxBytes: number; ttlSeconds: number },
  store: ApiCapacityStore = new RedisApiCapacityStore(getRedis()),
): Promise<ApiCapacityLease> {
  const key = `uno:capacity:api:${input.organizationId}`;
  let usedBytes = 0;
  let released = false;
  try {
    if (!await store.acquire(key, input.maxRequests, input.ttlSeconds)) {
      throw new AppError("rate_limit_exceeded", "Há muitas transferências em andamento.", 429, { retryAfterSeconds: 30 });
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
  }
  return {
    async addBytes(bytes) {
      if (released || !Number.isSafeInteger(bytes) || bytes < 0) throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
      try {
        if (!await store.addBytes(key, bytes, input.maxBytes, input.ttlSeconds)) {
          throw new AppError("rate_limit_exceeded", "O limite de transferências preparadas foi atingido.", 429, { retryAfterSeconds: 30 });
        }
        usedBytes += bytes;
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
      }
    },
    async release() {
      if (released) return;
      released = true;
      await store.release(key, usedBytes).catch(() => undefined);
    },
  };
}
