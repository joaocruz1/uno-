import { closeDb } from "@/db";
import { closeConversionQueue } from "@/server/queue/conversion-queue";
import { publishPendingConversionJobs } from "@/server/queue/outbox";

import { startConversionWorker } from "./conversion-worker";
import { startBatchWorker } from "./batch-worker";
import { startBillingWorker } from "./billing-worker";
import { startRetentionWorker } from "./retention-worker";
import { startWebhookWorker } from "./webhook-worker";

const running = startConversionWorker();
const batches = startBatchWorker();
const billing = startBillingWorker();
const webhooks = startWebhookWorker();
const retention = startRetentionWorker();
await publishPendingConversionJobs({ limit: 100 }).catch(() => undefined);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await batches.close();
  await billing.close();
  await webhooks.close();
  await retention.close();
  await running.close();
  await closeConversionQueue();
  await closeDb();
}

process.once("SIGINT", () => { void shutdown().then(() => process.exit(0)); });
process.once("SIGTERM", () => { void shutdown().then(() => process.exit(0)); });
