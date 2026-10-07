import type Redis from "ioredis";

import { AppError } from "@/lib/errors";
import { getRedis } from "@/server/redis";

export interface FixedWindowStore {
  increment(key: string, expiresAtUnixSeconds: number): Promise<number>;
}

class RedisFixedWindowStore implements FixedWindowStore {
  constructor(private readonly client: Redis) {}

  async increment(key: string, expiresAtUnixSeconds: number): Promise<number> {
    const value = await this.client.eval(
      "local value = redis.call('INCR', KEYS[1]); if value == 1 then redis.call('EXPIREAT', KEYS[1], ARGV[1]); end; return value",
      1,
      key,
      expiresAtUnixSeconds,
    );
    return Number(value);
  }
}

export type RateLimitInput = {
  namespace: string;
  identifier: string;
  limit: number;
  windowSeconds?: number;
  now?: Date;
};

export async function enforceRateLimit(
  input: RateLimitInput,
  store: FixedWindowStore = new RedisFixedWindowStore(getRedis()),
): Promise<void> {
  const windowSeconds = Math.max(1, Math.trunc(input.windowSeconds ?? 60));
  const nowMs = (input.now ?? new Date()).getTime();
  const windowMs = windowSeconds * 1_000;
  const bucket = Math.floor(nowMs / windowMs);
  const resetAtMs = (bucket + 1) * windowMs;
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAtMs - nowMs) / 1_000));
  let count: number;
  try {
    count = await store.increment(
      `uno:rate:${input.namespace}:${bucket}:${input.identifier}`,
      Math.ceil(resetAtMs / 1_000),
    );
  } catch {
    throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
  }
  if (!Number.isFinite(count) || count < 1) {
    throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
  }
  if (count > input.limit) {
    throw new AppError(
      "rate_limit_exceeded",
      "Muitas solicitações. Tente novamente em instantes.",
      429,
      { retryAfterSeconds },
    );
  }
}
