import {
  cancelUnentitledWebhookDeliveries,
  deliverDueWebhooks,
  fanOutPendingWebhookEvents,
  recoverExpiredWebhookClaims,
} from "@/server/webhooks";

export type RunningWebhookWorker = { close(): Promise<void> };

export function startWebhookWorker(): RunningWebhookWorker {
  let running = false;
  let stopped = false;

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
      await step(() => fanOutPendingWebhookEvents());
      await step(() => recoverExpiredWebhookClaims());
      await step(() => cancelUnentitledWebhookDeliveries());
      await step(() => deliverDueWebhooks());
    } finally {
      running = false;
    }
  };

  const interval = setInterval(() => { void tick(); }, 5_000);
  interval.unref();
  void tick();

  return {
    async close() {
      stopped = true;
      clearInterval(interval);
      while (running) await new Promise((resolve) => setTimeout(resolve, 25));
    },
  };
}
