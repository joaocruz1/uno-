import {
  cleanupExpiredBatchStagingObjects,
  cleanupExpiredBatchUploadSessions,
  finalizePreparingBatchUploads,
} from "@/server/batch-uploads";
import { processPendingBatchArchives } from "@/server/batches/archive";
import { reconcilePendingBatches } from "@/server/batches";
import { cleanupExpiredApiPreparations } from "@/server/api-ingestion";
import { processPendingMarketplaceCombines } from "@/server/marketplace/combine";

export type RunningBatchWorker = { close(): Promise<void> };

export function startBatchWorker(): RunningBatchWorker {
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await finalizePreparingBatchUploads();
      await cleanupExpiredBatchUploadSessions();
      await cleanupExpiredBatchStagingObjects();
      await cleanupExpiredApiPreparations();
      await reconcilePendingBatches();
      await processPendingBatchArchives();
      await processPendingMarketplaceCombines();
    } catch {
      // Durable database state is retried on the next maintenance tick.
    } finally {
      running = false;
    }
  };

  const maintenance = setInterval(() => { void tick(); }, 5_000);
  maintenance.unref();
  void tick();

  return {
    async close() {
      stopped = true;
      clearInterval(maintenance);
      while (running) await new Promise((resolve) => setTimeout(resolve, 25));
    },
  };
}
