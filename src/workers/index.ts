import { closeDb } from "@/db";
import { closeConversionQueue } from "@/server/queue/conversion-queue";
import { publishPendingConversionJobs } from "@/server/queue/outbox";

import { startConversionWorker } from "./conversion-worker";

const running = startConversionWorker();
await publishPendingConversionJobs({ limit: 100 }).catch(() => undefined);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await running.close();
  await closeConversionQueue();
  await closeDb();
}

process.once("SIGINT", () => { void shutdown().then(() => process.exit(0)); });
process.once("SIGTERM", () => { void shutdown().then(() => process.exit(0)); });
