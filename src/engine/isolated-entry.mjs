import { convertPdf } from "./index.ts";
import { EngineError } from "./errors.ts";

let accepted = false;

function send(message) {
  return new Promise((resolve, reject) => {
    if (!process.send || !process.connected) {
      reject(new Error("IPC unavailable"));
      return;
    }
    process.send(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function safeError(error) {
  if (error instanceof EngineError) {
    return {
      type: "error",
      code: error.code,
      terminal: error.terminal,
      suggestedSize: error.suggestedSize,
    };
  }
  return { type: "error", code: "invalid_pdf", terminal: true };
}

async function run(message) {
  try {
    if (
      !message ||
      message.type !== "job" ||
      !(message.bytes instanceof Uint8Array) ||
      !message.size ||
      typeof message.size !== "object"
    ) {
      await send({ type: "error", code: "invalid_pdf", terminal: true });
      return;
    }
    const result = await convertPdf(
      message.bytes,
      message.size,
      typeof message.selectedTemplate === "string" ? message.selectedTemplate : undefined,
      async (event) => send({ type: "progress", event }),
    );
    await send({ type: "result", result });
  } catch (error) {
    try {
      await send(safeError(error));
    } catch {
      // The parent owns failure reporting and may already have terminated IPC.
    }
  } finally {
    process.disconnect?.();
  }
}

process.once("message", (message) => {
  if (accepted) return;
  accepted = true;
  void run(message).finally(() => process.exit(0));
});

process.once("disconnect", () => process.exit(1));
