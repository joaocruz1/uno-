// Test-only stand-in for src/engine/isolated-entry.mjs, selected through
// UNO_ENGINE_CHILD_ENTRY (honoured only under Vitest). It completes the
// handshake and then answers every job with a message for another job id,
// which the parent must treat as a protocol violation.
const FOREIGN_JOB_ID = "00000000-0000-4000-8000-000000000000";

process.on("message", () => {
  process.send?.({ type: "progress", jobId: FOREIGN_JOB_ID, event: { stage: "analyze", progress: 10 } });
});
process.once("disconnect", () => process.exit(1));
process.send?.({ type: "ready" });
