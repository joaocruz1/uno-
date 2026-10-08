import { randomUUID } from "node:crypto";
import { lstat, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngineError, type EngineErrorCode } from "./errors";
import {
  EngineChildPool,
  engineChildPoolSize,
  isLiveEngineWorkspaceRoot,
  processGroupRssReader,
  type EngineChildPoolStats,
  type ResidentEngineChild,
} from "./isolated-child";
import type { ConversionResult, OutputSize, ProductHeader, ProgressEvent, ProgressHandler } from "./types";

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
const WORKSPACE_NAME = /^uno-engine-[A-Za-z0-9]{6}$/;
const MIN_ABANDONED_WORKSPACE_AGE_MS = 2 * MAX_TIMEOUT_MS;

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
  /** Caller-supplied picking data drawn above the label. */
  product?: ProductHeader;
  timeoutMs?: number;
  maxHeapMb?: number;
  maxRssMb?: number;
};

type ChildProgressMessage = { type: "progress"; jobId: string; event: ProgressEvent };
type ChildResultMessage = { type: "result"; jobId: string; result: ConversionResult };
type ChildErrorMessage = {
  type: "error";
  jobId: string;
  code: EngineErrorCode;
  terminal?: boolean;
  suggestedSize?: OutputSize;
  /** The child hit an untyped failure and asks to be replaced. */
  retire?: boolean;
};
type ChildMessage = ChildProgressMessage | ChildResultMessage | ChildErrorMessage;

export class EngineIsolationError extends Error {
  readonly code = "engine_unavailable";
  readonly terminal = false;

  constructor() {
    super("O processamento está temporariamente indisponível.");
    this.name = "EngineIsolationError";
  }
}

function isolationFailure() {
  return new EngineIsolationError();
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

function isChildMessage(value: unknown, jobId: string): value is ChildMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ChildMessage>;
  if (candidate.jobId !== jobId) return false;
  if (candidate.type === "progress") return isProgressEvent((candidate as Partial<ChildProgressMessage>).event);
  if (candidate.type === "result") return isConversionResult((candidate as Partial<ChildResultMessage>).result);
  if (candidate.type === "error") return ENGINE_ERROR_CODES.has((candidate as Partial<ChildErrorMessage>).code as EngineErrorCode);
  return false;
}

function reconstructError(message: ChildErrorMessage) {
  if (!ENGINE_ERROR_CODES.has(message.code)) return isolationFailure();
  return new EngineError(message.code, {
    terminal: typeof message.terminal === "boolean" ? message.terminal : undefined,
    suggestedSize: isOutputSize(message.suggestedSize) ? message.suggestedSize : undefined,
  });
}

/**
 * Removes private per-run workspaces left behind when a parent process died
 * before its own cleanup ran. Only real directories created by this module
 * (name pattern, owned by this user, private mode) and older than `maxAgeMs`
 * are removed. Symbolic links are never followed: a link in place of a
 * workspace is ignored and links inside one are unlinked, not traversed.
 * Roots of live pools of this process are skipped whatever their age.
 * `root` is an operator/test override; it must never come from a request.
 */
export async function recoverAbandonedEngineWorkspaces(
  options: { maxAgeMs: number; now?: Date; root?: string },
): Promise<number> {
  if (!Number.isSafeInteger(options.maxAgeMs) || options.maxAgeMs < MIN_ABANDONED_WORKSPACE_AGE_MS) {
    throw new RangeError("maxAgeMs must not be shorter than twice the engine deadline");
  }
  const root = options.root ?? tmpdir();
  const now = (options.now ?? new Date()).getTime();
  const ownerId = typeof process.getuid === "function" ? process.getuid() : undefined;
  let names: string[];
  try {
    if (!(await lstat(root)).isDirectory()) return 0;
    names = await readdir(root);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!WORKSPACE_NAME.test(name)) continue;
    const directory = join(root, name);
    try {
      const entry = await lstat(directory);
      if (
        entry.isSymbolicLink() || !entry.isDirectory() ||
        isLiveEngineWorkspaceRoot(directory, entry) ||
        (ownerId !== undefined && entry.uid !== ownerId) ||
        (process.platform !== "win32" && (entry.mode & 0o077) !== 0) ||
        now - entry.mtimeMs < options.maxAgeMs
      ) continue;
      await rm(directory, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Left for the next pass; a workspace that vanished meanwhile is fine.
    }
  }
  return removed;
}

let pool: EngineChildPool | undefined;

function enginePool() {
  pool ??= new EngineChildPool({ size: engineChildPoolSize() });
  return pool;
}

/** Pre-spawns the resident children so the first job does not pay the boot. */
export function warmEngineChildPool(): Promise<void> {
  return enginePool().warm();
}

/** Terminates every child, fails pending jobs and removes the pool root. */
export async function closeEngineChildPool(): Promise<void> {
  const current = pool;
  pool = undefined;
  await current?.close();
}

export function engineChildPoolStats(): EngineChildPoolStats | undefined {
  return pool?.stats();
}

/**
 * Converts one PDF in a bounded, resident Node process. The deadline starts
 * now and also covers the wait for a free child. While the job is dispatched
 * the child's process group is watched for RSS; any isolation failure (deadline,
 * memory, exit, IPC or protocol error, caller progress handler throwing) kills
 * the group and retires the child. A typed engine error keeps the child.
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
    throw new EngineError("invalid_pdf");
  }

  const engine = enginePool();
  const jobId = randomUUID();
  const rssLimitKb = rssFor(options) * 1_024;

  return new Promise<ConversionResult>((resolve, reject) => {
    let settled = false;
    let terminalReceived = false;
    let child: ResidentEngineChild | undefined;
    let workspace: string | undefined;
    let progressQueue = Promise.resolve();
    let rssTimer: NodeJS.Timeout | undefined;
    const acquisition = new AbortController();

    // Idempotent: hands the child back (or retires it, waiting for the group
    // to die) and then removes the job workspace again.
    const releaseChild = async (retire: boolean) => {
      const held = child;
      child = undefined;
      if (rssTimer) clearTimeout(rssTimer);
      if (!held) return;
      held.detach();
      try {
        await engine.release(held, { retire });
      } finally {
        if (workspace) await rm(workspace, { recursive: true, force: true });
      }
    };
    const fail = (error: EngineError | EngineIsolationError = isolationFailure()) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      acquisition.abort();
      void releaseChild(true).then(
        () => reject(error),
        () => reject(error),
      );
    };
    const settleAfterTerminal = (retire: boolean, outcome: () => void) => {
      terminalReceived = true;
      const released = releaseChild(retire);
      void progressQueue
        .then(() => released)
        .then(() => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          outcome();
        })
        .catch(() => fail());
    };
    const deadline = setTimeout(() => fail(), timeoutFor(options));
    deadline.unref();

    const scheduleRssCheck = () => {
      const pid = child?.pid;
      // Windows cannot enforce aggregate process-group RSS here. Deployments on
      // that platform must provide a container/job-object memory limit instead.
      if (process.platform === "win32" || process.env.VITEST === "true" || !pid || settled || terminalReceived) return;
      rssTimer = setTimeout(() => {
        void processGroupRssReader()
          .then((read) => read(pid))
          .then(
            (rssKb) => {
              if (settled || terminalReceived || child?.pid !== pid) return;
              if (rssKb > rssLimitKb) {
                fail();
                return;
              }
              scheduleRssCheck();
            },
            () => {
              if (!terminalReceived) fail();
            },
          );
      }, RSS_POLL_INTERVAL_MS);
      rssTimer.unref();
    };

    const onMessage = (rawMessage: unknown) => {
      if (settled || terminalReceived) return;
      if (!isChildMessage(rawMessage, jobId)) {
        fail();
        return;
      }
      if (rawMessage.type === "progress") {
        progressQueue = progressQueue.then(async () => {
          await onProgress?.(rawMessage.event);
        });
        void progressQueue.catch(() => {
          if (!terminalReceived) fail();
        });
        return;
      }
      if (rawMessage.type === "error") {
        settleAfterTerminal(rawMessage.retire === true, () => reject(reconstructError(rawMessage)));
        return;
      }
      settleAfterTerminal(false, () => resolve(rawMessage.result));
    };

    engine.acquire(heapFor(options), acquisition.signal).then(
      (acquired) => {
        if (settled) {
          void engine.release(acquired, { retire: false }).catch(() => undefined);
          return;
        }
        child = acquired;
        workspace = join(acquired.root, `job-${jobId}`);
        acquired.attach({ onMessage, onExit: () => fail() });
        scheduleRssCheck();
        acquired.send({
          type: "job",
          jobId,
          workspace,
          bytes: Uint8Array.from(bytes),
          size,
          selectedTemplate,
          ...(options.product ? { product: options.product } : {}),
        }).catch(() => fail());
      },
      () => fail(),
    );
  });
}
