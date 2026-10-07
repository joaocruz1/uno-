import { execFile, fork, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngineError, type EngineErrorCode } from "./errors";
import type { ConversionResult, OutputSize, ProgressEvent, ProgressHandler } from "./types";

const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_HEAP_MB = 256;
const MIN_HEAP_MB = 128;
const MAX_HEAP_MB = 512;
const DEFAULT_RSS_MB = 768;
const MIN_RSS_MB = 128;
const MAX_RSS_MB = 1_024;
const MAX_INPUT_BYTES = 100 * 1_024 * 1_024;
const RSS_POLL_INTERVAL_MS = 250;

const ENGINE_ERROR_CODES = new Set<EngineErrorCode>([
  "invalid_pdf",
  "pdf_encrypted",
  "invalid_page_count",
  "unsupported_template",
  "ambiguous_template",
  "missing_required_region",
  "codes_unreadable",
  "format_too_small",
  "validation_failed",
  "ocr_unavailable",
]);

type IsolationOptions = {
  timeoutMs?: number;
  maxHeapMb?: number;
  maxRssMb?: number;
};

type ChildProgressMessage = { type: "progress"; event: ProgressEvent };
type ChildResultMessage = { type: "result"; result: ConversionResult };
type ChildErrorMessage = {
  type: "error";
  code: EngineErrorCode;
  terminal?: boolean;
  suggestedSize?: OutputSize;
};
type ChildMessage = ChildProgressMessage | ChildResultMessage | ChildErrorMessage;

function genericFailure() {
  return new EngineError("invalid_pdf");
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value as number)));
}

function timeoutFor(options: IsolationOptions) {
  const minimum = process.env.NODE_ENV === "production" ? 1_000 : 1;
  return boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, minimum, MAX_TIMEOUT_MS);
}

function heapFor(options: IsolationOptions) {
  return boundedInteger(options.maxHeapMb, DEFAULT_HEAP_MB, MIN_HEAP_MB, MAX_HEAP_MB);
}

function rssFor(options: IsolationOptions) {
  return boundedInteger(options.maxRssMb, DEFAULT_RSS_MB, MIN_RSS_MB, MAX_RSS_MB);
}

function processGroupRssKb(processGroupId: number) {
  return new Promise<number>((resolve, reject) => {
    execFile(
      "ps",
      ["-axo", "pgid=,rss="],
      {
        encoding: "utf8",
        env: Object.fromEntries(
          Object.entries({ PATH: process.env.PATH, LANG: process.env.LANG })
            .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        ) as NodeJS.ProcessEnv,
        maxBuffer: 1_024 * 1_024,
        timeout: 1_000,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }

        let totalKb = 0;
        for (const line of stdout.split("\n")) {
          const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
          if (!match || Number(match[1]) !== processGroupId) continue;
          totalKb += Number(match[2]);
        }
        resolve(totalKb);
      },
    );
  });
}

function isOutputSize(value: unknown): value is OutputSize {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<OutputSize> & { widthMm?: unknown; heightMm?: unknown };
  if (candidate.preset === "100x150" || candidate.preset === "100x100" || candidate.preset === "a6") return true;
  return (
    candidate.preset === "custom" &&
    typeof candidate.widthMm === "number" &&
    Number.isFinite(candidate.widthMm) &&
    candidate.widthMm >= 50 &&
    candidate.widthMm <= 210 &&
    typeof candidate.heightMm === "number" &&
    Number.isFinite(candidate.heightMm) &&
    candidate.heightMm >= 50 &&
    candidate.heightMm <= 300
  );
}

function isProgressEvent(value: unknown): value is ProgressEvent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ProgressEvent>;
  return (
    ["analyze", "detect", "extract", "layout", "compose", "validate"].includes(candidate.stage ?? "") &&
    typeof candidate.progress === "number" &&
    Number.isFinite(candidate.progress) &&
    candidate.progress >= 0 &&
    candidate.progress <= 100
  );
}

function isConversionResult(value: unknown): value is ConversionResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ConversionResult>;
  return (
    candidate.bytes instanceof Uint8Array &&
    candidate.bytes.byteLength > 0 &&
    candidate.pageCount === 1 &&
    typeof candidate.widthMm === "number" &&
    typeof candidate.heightMm === "number" &&
    Boolean(candidate.versions) &&
    Boolean(candidate.validation) &&
    Boolean(candidate.timingsMs) &&
    Array.isArray(candidate.pages)
  );
}

function isChildMessage(value: unknown): value is ChildMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ChildMessage>;
  if (candidate.type === "progress") return isProgressEvent((candidate as Partial<ChildProgressMessage>).event);
  if (candidate.type === "result") return isConversionResult((candidate as Partial<ChildResultMessage>).result);
  if (candidate.type === "error") return ENGINE_ERROR_CODES.has((candidate as Partial<ChildErrorMessage>).code as EngineErrorCode);
  return false;
}

function reconstructError(message: ChildErrorMessage) {
  if (!ENGINE_ERROR_CODES.has(message.code)) return genericFailure();
  return new EngineError(message.code, {
    terminal: typeof message.terminal === "boolean" ? message.terminal : undefined,
    suggestedSize: isOutputSize(message.suggestedSize) ? message.suggestedSize : undefined,
  });
}

function childEnvironment(jobDirectory: string): NodeJS.ProcessEnv {
  const allowed: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    TESSDATA_PREFIX: process.env.TESSDATA_PREFIX,
    LANG: process.env.LANG,
    NODE_ENV: process.env.NODE_ENV,
    TMPDIR: jobDirectory,
    UNO_ENGINE_TMP_DIR: jobDirectory,
    UNO_ISOLATED_CHILD: "1",
  };
  return Object.fromEntries(
    Object.entries(allowed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  ) as NodeJS.ProcessEnv;
}

function killProcessGroup(child: ChildProcess) {
  const leaderIsRunning = child.exitCode === null && child.signalCode === null;
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall through when the group no longer exists or cannot be signalled.
    }
  }
  if (leaderIsRunning) child.kill("SIGKILL");
}

async function stopChildAndRemoveWorkspace(child: ChildProcess, jobDirectory: string) {
  const ignoreCleanupError = () => undefined;
  child.once("error", ignoreCleanupError);
  const exited = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });
  try {
    killProcessGroup(child);
    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);
  } finally {
    child.removeListener("error", ignoreCleanupError);
    await rm(jobDirectory, { recursive: true, force: true });
  }
}

/**
 * Converts one PDF in a bounded, disposable Node process. The child receives
 * exactly one job and is terminated on every success or failure path.
 */
export async function convertPdfIsolated(
  bytes: Uint8Array,
  size: OutputSize,
  selectedTemplate?: string,
  onProgress?: ProgressHandler,
  options: IsolationOptions = {},
): Promise<ConversionResult> {
  if (
    typeof window !== "undefined" ||
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 1 ||
    bytes.byteLength > MAX_INPUT_BYTES ||
    !isOutputSize(size)
  ) {
    throw genericFailure();
  }

  let jobDirectory = "";
  try {
    jobDirectory = await mkdtemp(join(tmpdir(), "uno-engine-"));
    await chmod(jobDirectory, 0o700);
  } catch {
    if (jobDirectory) {
      await rm(jobDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
    throw genericFailure();
  }

  let child: ChildProcess;
  try {
    child = fork(new URL("./isolated-entry.mjs", import.meta.url), [], {
      cwd: process.cwd(),
      detached: process.platform !== "win32",
      env: childEnvironment(jobDirectory),
      execArgv: [`--max-old-space-size=${heapFor(options)}`, "--import", "tsx"],
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
  } catch {
    await rm(jobDirectory, { recursive: true, force: true });
    throw genericFailure();
  }

  return new Promise<ConversionResult>((resolve, reject) => {
    let settled = false;
    let terminalReceived = false;
    let progressQueue = Promise.resolve();
    let rssTimer: NodeJS.Timeout | undefined;

    const cleanup = async () => {
      clearTimeout(deadline);
      if (rssTimer) clearTimeout(rssTimer);
      child.removeAllListeners("message");
      child.removeAllListeners("error");
      child.removeAllListeners("exit");
      await stopChildAndRemoveWorkspace(child, jobDirectory);
    };
    const fail = (error: EngineError = genericFailure()) => {
      if (settled) return;
      settled = true;
      void cleanup().then(
        () => reject(error),
        () => reject(error),
      );
    };
    const succeed = (result: ConversionResult) => {
      if (settled) return;
      settled = true;
      void cleanup().then(
        () => resolve(result),
        () => reject(genericFailure()),
      );
    };
    const deadline = setTimeout(() => fail(), timeoutFor(options));
    deadline.unref();

    const scheduleRssCheck = () => {
      if (
        process.platform === "win32" ||
        process.env.VITEST === "true" ||
        !child.pid ||
        settled
      ) return;
      rssTimer = setTimeout(() => {
        void processGroupRssKb(child.pid as number).then(
          (rssKb) => {
            if (rssKb > rssFor(options) * 1_024) {
              fail();
              return;
            }
            scheduleRssCheck();
          },
          () => fail(),
        );
      }, RSS_POLL_INTERVAL_MS);
      rssTimer.unref();
    };

    // Windows cannot enforce aggregate process-group RSS here. Deployments on
    // that platform must provide a container/job-object memory limit instead.
    scheduleRssCheck();

    child.on("error", () => fail());
    child.on("exit", () => {
      if (!settled && !terminalReceived) fail();
    });
    child.on("message", (rawMessage: unknown) => {
      if (settled || !isChildMessage(rawMessage)) {
        if (!settled) fail();
        return;
      }
      if (rawMessage.type === "progress") {
        progressQueue = progressQueue.then(async () => {
          await onProgress?.(rawMessage.event);
        });
        void progressQueue.catch(() => fail());
        return;
      }
      if (rawMessage.type === "error") {
        terminalReceived = true;
        void progressQueue.then(() => fail(reconstructError(rawMessage))).catch(() => fail());
        return;
      }
      terminalReceived = true;
      void progressQueue.then(() => succeed(rawMessage.result)).catch(() => fail());
    });

    try {
      child.send(
        {
          type: "job",
          bytes: Uint8Array.from(bytes),
          size,
          selectedTemplate,
        },
        (error) => {
          if (error) fail();
        },
      );
    } catch {
      fail();
    }
  });
}
