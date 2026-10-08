import { Worker, createIORedisClient, type Job } from "bullmq";
import Redis from "ioredis";

import { closeEngineChildPool, warmEngineChildPool } from "@/engine/isolated";
import { positiveIntegerEnv, requiredEnv } from "@/lib/env";
import {
  processConversion,
  reconcileExpiredConversionClaims,
  recoverOrphanedQueuedConversions,
  recoverQueuedConversion,
} from "@/server/conversions";
import {
  CONVERSION_JOB_NAME,
  CONVERSION_QUEUE_NAME,
  type ConversionJobData,
} from "@/server/queue/conversion-queue";
import { publishPendingConversionJobs } from "@/server/queue/outbox";

import { requestWebhookCycle } from "./webhook-worker";

export type RunningConversionWorker = {
  worker: Worker<ConversionJobData>;
  close(): Promise<void>;
};

const MAX_CONVERSION_CONCURRENCY = 4;

/** BullMQ slots, and by default the number of resident engine children. */
function conversionConcurrency() {
  return Math.min(MAX_CONVERSION_CONCURRENCY, Math.max(1, positiveIntegerEnv("UNO_CONVERSION_CONCURRENCY", 1)));
}

export function startConversionWorker(): RunningConversionWorker {
  const redis = new Redis(requiredEnv("REDIS_URL"), {
    lazyConnect: true,
    enableReadyCheck: true,
    maxRetriesPerRequest: null,
    connectTimeout: 10_000,
  });
  redis.on("error", () => undefined);
  const worker = new Worker<ConversionJobData>(
    CONVERSION_QUEUE_NAME,
    async (job: Job<ConversionJobData>) => {
      if (job.name !== CONVERSION_JOB_NAME) return;
      await processConversion(job.data.conversionId);
    },
    {
      connection: createIORedisClient(redis),
      concurrency: conversionConcurrency(),
      lockDuration: 120_000,
      maxStalledCount: 2,
      removeOnComplete: { age: 86_400, count: 5_000 },
      removeOnFail: { age: 604_800, count: 5_000 },
    },
  );
  // A settled job wrote `conversion.completed` or `conversion.failed` to the
  // outbox; deliver the webhooks now instead of on the next 5 s tick.
  worker.on("completed", () => requestWebhookCycle());
  worker.on("failed", (job) => {
    requestWebhookCycle();
    if (job?.data.conversionId) {
      void recoverQueuedConversion(job.data.conversionId, job.id ?? "unknown").catch(() => undefined);
      void reconcileExpiredConversionClaims().catch(() => undefined);
    }
  });
  worker.on("error", () => undefined);
  // Boot the resident engine children now so the first job does not pay for it.
  void warmEngineChildPool().catch(() => undefined);

  const maintenance = setInterval(() => {
    void publishPendingConversionJobs({ limit: 50 }).catch(() => undefined);
    void reconcileExpiredConversionClaims().catch(() => undefined);
    void recoverOrphanedQueuedConversions().catch(() => undefined);
  }, 5_000);
  maintenance.unref();

  return {
    worker,
    async close() {
      clearInterval(maintenance);
      await worker.close();
      await closeEngineChildPool();
      redis.disconnect(false);
    },
  };
}
