// Resident engine child. The parent forks it with TMPDIR set to the private
// root of its pool. It pre-warms the engine, announces `ready`, then serves
// one job at a time, each inside its own `job-<uuid>` workspace in that root.
// Every outgoing job message carries the job id. Anything unexpected from the
// parent (job while busy, malformed envelope, workspace outside the root) ends
// the process, and so does losing the IPC channel.
import { chmod, mkdir, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

import { convertPdf } from "./index.ts";
import { EngineError } from "./errors.ts";
import { openPdfRenderer } from "./render.ts";

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WORKSPACE_NAME = /^job-[0-9a-f-]{36}$/;

const root = process.env.TMPDIR && isAbsolute(process.env.TMPDIR) ? resolve(process.env.TMPDIR) : undefined;
let warmed = false;
let busy = false;

function send(message) {
  return new Promise((resolvePromise, reject) => {
    if (!process.send || !process.connected) {
      reject(new Error("IPC unavailable"));
      return;
    }
    process.send(message, (error) => {
      if (error) reject(error);
      else resolvePromise();
    });
  });
}

function safeError(error, jobId) {
  if (error instanceof EngineError) {
    return {
      type: "error",
      jobId,
      code: error.code,
      terminal: error.terminal,
      suggestedSize: error.suggestedSize,
    };
  }
  // Unknown failure: report a safe code and ask the parent to retire this process.
  return { type: "error", jobId, code: "invalid_pdf", terminal: true, retire: true };
}

function isJobEnvelope(message) {
  if (!message || typeof message !== "object" || message.type !== "job") return false;
  if (typeof message.jobId !== "string" || !JOB_ID.test(message.jobId)) return false;
  if (typeof message.workspace !== "string" || !isAbsolute(message.workspace)) return false;
  const workspace = resolve(message.workspace);
  const name = basename(workspace);
  return (
    workspace === message.workspace &&
    dirname(workspace) === root &&
    WORKSPACE_NAME.test(name) &&
    name === `job-${message.jobId}`
  );
}

async function prewarm() {
  // Loads what the first job would otherwise import lazily, then renders one
  // synthetic page so the PDF.js fake worker, the canvas globals and the
  // native canvas are initialised before any real document arrives.
  const [, , pdfLib] = await Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("@napi-rs/canvas"),
    import("pdf-lib"),
  ]);
  const document = await pdfLib.PDFDocument.create();
  const page = document.addPage([144, 144]);
  const font = await document.embedFont(pdfLib.StandardFonts.Helvetica);
  page.drawRectangle({ x: 24, y: 24, width: 96, height: 48, color: pdfLib.rgb(0, 0, 0) });
  page.drawText("UNO", { x: 24, y: 96, size: 18, font });
  const renderer = await openPdfRenderer(await document.save());
  try {
    await renderer.render(1, 72, 0);
  } finally {
    await renderer.close();
  }
}

async function runJob(message) {
  const { jobId, workspace } = message;
  try {
    await mkdir(workspace, { mode: 0o700 });
    await chmod(workspace, 0o700);
  } catch {
    process.exit(1);
  }

  let outcome;
  process.env.TMPDIR = workspace;
  process.env.UNO_ENGINE_TMP_DIR = workspace;
  try {
    if (!(message.bytes instanceof Uint8Array) || !message.size || typeof message.size !== "object") {
      outcome = { type: "error", jobId, code: "invalid_pdf", terminal: true };
    } else {
      const result = await convertPdf(
        message.bytes,
        message.size,
        typeof message.selectedTemplate === "string" ? message.selectedTemplate : undefined,
        async (event) => send({ type: "progress", jobId, event }),
        message.product && typeof message.product === "object" ? { product: message.product } : {},
      );
      outcome = { type: "result", jobId, result };
    }
  } catch (error) {
    outcome = safeError(error, jobId);
  } finally {
    process.env.TMPDIR = root;
    delete process.env.UNO_ENGINE_TMP_DIR;
    try {
      await rm(workspace, { recursive: true, force: true });
    } catch {
      process.exit(1);
    }
  }

  // Idle and clean before the parent learns the outcome, so it may dispatch
  // the next job as soon as this message arrives.
  busy = false;
  await send(outcome);
}

process.on("message", (message) => {
  if (!warmed || busy || !isJobEnvelope(message)) {
    process.exit(1);
  }
  busy = true;
  void runJob(message).catch(() => process.exit(1));
});

process.once("disconnect", () => process.exit(1));

if (!root) process.exit(1);
try {
  await prewarm();
  warmed = true;
  await send({ type: "ready" });
} catch {
  process.exit(1);
}
