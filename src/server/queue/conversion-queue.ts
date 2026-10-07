import { Queue, createIORedisClient } from "bullmq";
import Redis from "ioredis";

import { requiredEnv } from "@/lib/env";

export const CONVERSION_QUEUE_NAME = "uno-conversions";
export const CONVERSION_JOB_NAME = "convert";

export type ConversionJobData = { conversionId: string };

let producerRedis: Redis | undefined;
let conversionQueue: Queue<ConversionJobData> | undefined;

function producerConnection() {
  producerRedis ??= new Redis(requiredEnv("REDIS_URL"), {
    lazyConnect: true,
    enableReadyCheck: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
  });
  producerRedis.on("error", () => undefined);
  return createIORedisClient(producerRedis);
}

export function conversionJobId(conversionId: string, outboxEventId: string): string {
  return `conversion-${conversionId}-${outboxEventId}`.replace(/[^A-Za-z0-9_-]/g, "-");
}

export function getConversionQueue(): Queue<ConversionJobData> {
  conversionQueue ??= new Queue<ConversionJobData>(CONVERSION_QUEUE_NAME, {
    connection: producerConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: { age: 86_400, count: 5_000 },
      removeOnFail: { age: 604_800, count: 5_000 },
    },
  });
  return conversionQueue;
}

export async function enqueueConversion(conversionId: string, outboxEventId: string): Promise<void> {
  const queue = getConversionQueue();
  const jobId = conversionJobId(conversionId, outboxEventId);
  const existing = await queue.getJob(jobId);
  if (existing) return;
  await queue.add(CONVERSION_JOB_NAME, { conversionId }, { jobId });
}

export async function closeConversionQueue(): Promise<void> {
  await conversionQueue?.close();
  conversionQueue = undefined;
  producerRedis?.disconnect(false);
  producerRedis = undefined;
}
