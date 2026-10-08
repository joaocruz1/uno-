import {
  cancelUnentitledWebhookDeliveries,
  deliverDueWebhooks,
  fanOutPendingWebhookEvents,
  recoverExpiredWebhookClaims,
} from "@/server/webhooks";

export type RunningWebhookWorker = { close(): Promise<void>; wake(): void };

let activeWorker: RunningWebhookWorker | undefined;

/**
 * Runs a delivery cycle now instead of waiting for the next periodic tick.
 * Called by the conversion worker right after a conversion settles so that
 * `conversion.completed` / `conversion.failed` webhooks leave within the
 * same second. A no-op when no webhook worker runs in this process.
 */
export function requestWebhookCycle(): void {
  activeWorker?.wake();
}

export function startWebhookWorker(): RunningWebhookWorker {
  let running = false;
  let stopped = false;
  let wakeRequested = false;

  const step = async (work: () => Promise<unknown>) => {
    if (stopped) return;
    try {
      await work();
    } catch {
      // Durable database state is retried on the next tick.
    }
  };

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      do {
        wakeRequested = false;
        await step(() => fanOutPendingWebhookEvents());
        await step(() => recoverExpiredWebhookClaims());
        await step(() => cancelUnentitledWebhookDeliveries());
        await step(() => deliverDueWebhooks());
        // A wake that arrived while this cycle ran is served right away so no
        // delivery waits for the periodic tick.
      } while (wakeRequested && !stopped);
    } finally {
      running = false;
    }
  };

  const interval = setInterval(() => { void tick(); }, 5_000);
  interval.unref();
  void tick();

  const worker: RunningWebhookWorker = {
    wake() {
      if (stopped) return;
      wakeRequested = true;
      void tick();
    },
    async close() {
      stopped = true;
      clearInterval(interval);
      if (activeWorker === worker) activeWorker = undefined;
      while (running) await new Promise((resolve) => setTimeout(resolve, 25));
    },
  };
  activeWorker = worker;
  return worker;
}
