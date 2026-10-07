import { reconcileStaleSubscriptions } from "@/server/billing";

const INTERVAL_MS = 5 * 60_000;

export function startBillingWorker() {
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await reconcileStaleSubscriptions();
    } catch {
      // Stripe/DB retries are driven by the durable webhook ledger and this
      // periodic pass. Provider messages and configuration values stay private.
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, INTERVAL_MS);
  timer.unref();
  void tick();
  return {
    async close() {
      stopped = true;
      clearInterval(timer);
      while (running) await new Promise((resolve) => setTimeout(resolve, 10));
    },
  };
}
