import { readRetentionConfig, runRetentionCycle } from "@/server/retention";

export type RunningRetentionWorker = { close(): Promise<void> };

/**
 * Periodically removes expired artifacts. Configuration is validated before the
 * first cycle: an invalid security-relevant value throws here instead of
 * silently running with a default.
 */
export function startRetentionWorker(): RunningRetentionWorker {
  const config = readRetentionConfig();
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await runRetentionCycle(config);
    } catch {
      // Durable `deleting` claims and expiry timestamps are retried on the next tick.
    } finally {
      running = false;
    }
  };

  const maintenance = setInterval(() => { void tick(); }, config.intervalMs);
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
