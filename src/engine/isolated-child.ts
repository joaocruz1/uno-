import { execFile, fork, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { chmod, lstat, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { positiveIntegerEnv } from "../lib/env";

/**
 * Resident engine children. Each pool owns one private root directory
 * (`uno-engine-XXXXXX`, mode 0700) that is the `TMPDIR` of all its children
 * for the whole life of the parent process; every job gets its own
 * `job-<uuid>` workspace inside it, created and removed by the child and
 * removed again by the parent. Children are retired on any isolation failure,
 * after a bounded number of jobs, when idle for too long or when an idle RSS
 * sample is too high. A typed engine error does not retire a child.
 */

const SPAWN_TIMEOUT_MS = 20_000;
const RESPAWN_BACKOFF_MS = [1_000, 2_000, 5_000] as const;
const TERMINATE_GRACE_MS = 1_000;
const ROOT_PREFIX = "uno-engine-";
const DEFAULT_MAX_JOBS = 50;
const DEFAULT_IDLE_MS = 600_000;
const DEFAULT_WORKSPACE_MAX_AGE_MS = 3_600_000;
// Measured on macOS: a warmed child idles at ~570 MB RSS and creeps to
// ~650-730 MB after a few jobs (V8 heap stays ~125 MB; the rest is native).
// Retiring above 640 MB keeps headroom under the default 768 MB job limit
// without replacing a healthy child after every job.
const DEFAULT_IDLE_RSS_MB = 640;
const MAX_POOL_SIZE = 4;

export type ProcessGroupRssReader = (processGroupId: number) => Promise<number>;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

/** Slots of the module pool: `UNO_ENGINE_CHILD_POOL_SIZE`, else `UNO_CONVERSION_CONCURRENCY`, 1..4. */
export function engineChildPoolSize(): number {
  const concurrency = clamp(positiveIntegerEnv("UNO_CONVERSION_CONCURRENCY", 1), 1, MAX_POOL_SIZE);
  return clamp(positiveIntegerEnv("UNO_ENGINE_CHILD_POOL_SIZE", concurrency), 1, MAX_POOL_SIZE);
}

function maxJobsPerChild() {
  return positiveIntegerEnv("UNO_ENGINE_CHILD_MAX_JOBS", DEFAULT_MAX_JOBS);
}

function idleRetirementMs() {
  // An idle child must not outlive the age after which workspaces are treated as abandoned.
  return Math.min(
    positiveIntegerEnv("UNO_ENGINE_CHILD_IDLE_MS", DEFAULT_IDLE_MS),
    positiveIntegerEnv("UNO_ENGINE_TMP_MAX_AGE_MS", DEFAULT_WORKSPACE_MAX_AGE_MS),
  );
}

function idleRssLimitKb() {
  return positiveIntegerEnv("UNO_ENGINE_CHILD_IDLE_RSS_MB", DEFAULT_IDLE_RSS_MB) * 1_024;
}

/** Process group id from the text of `/proc/<pid>/stat`; the command name may contain `)`. */
export function processGroupFromProcStat(stat: string): number | undefined {
  const close = stat.lastIndexOf(")");
  if (close < 0) return undefined;
  // After the command: state, ppid, pgrp, ...
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const processGroupId = Number(fields[2]);
  return Number.isSafeInteger(processGroupId) && processGroupId > 0 ? processGroupId : undefined;
}

/** Aggregate RSS (kB) of a process group read from `/proc` without spawning anything. */
export async function readProcessGroupRssKbFromProc(processGroupId: number, procRoot = "/proc"): Promise<number> {
  const names = (await readdir(procRoot)).filter((name) => /^\d+$/.test(name));
  const sizes = await Promise.all(names.map(async (name) => {
    try {
      const processGroup = processGroupFromProcStat(await readFile(join(procRoot, name, "stat"), "utf8"));
      if (processGroup !== processGroupId) return 0;
      const match = /^VmRSS:\s+(\d+)\s+kB\s*$/m.exec(await readFile(join(procRoot, name, "status"), "utf8"));
      return match ? Number(match[1]) : 0;
    } catch {
      // The process exited between listing and reading.
      return 0;
    }
  }));
  return sizes.reduce((total, size) => total + size, 0);
}

/** Aggregate RSS (kB) of a process group via `ps` (macOS, or Linux without a usable `/proc`). */
export function readProcessGroupRssKbFromPs(processGroupId: number): Promise<number> {
  return new Promise<number>((resolvePromise, reject) => {
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
        resolvePromise(totalKb);
      },
    );
  });
}

async function procReaderWorks(procRoot = "/proc") {
  if (process.platform !== "linux") return false;
  try {
    const ownGroup = processGroupFromProcStat(await readFile(join(procRoot, "self", "stat"), "utf8"));
    return ownGroup !== undefined && (await readProcessGroupRssKbFromProc(ownGroup, procRoot)) > 0;
  } catch {
    return false;
  }
}

let selectedRssReader: Promise<ProcessGroupRssReader> | undefined;

/** `/proc` reader when it can measure this very process, `ps` otherwise. Probed once. */
export function processGroupRssReader(): Promise<ProcessGroupRssReader> {
  selectedRssReader ??= procReaderWorks().then((usable) => (
    usable ? readProcessGroupRssKbFromProc : readProcessGroupRssKbFromPs
  ));
  return selectedRssReader;
}

/** The only variables a child inherits. `UNO_ENGINE_TMP_DIR` is set by the child per job. */
export function childEnvironment(root: string): NodeJS.ProcessEnv {
  const allowed: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    TESSDATA_PREFIX: process.env.TESSDATA_PREFIX,
    LANG: process.env.LANG,
    NODE_ENV: process.env.NODE_ENV,
    TMPDIR: root,
    UNO_ISOLATED_CHILD: "1",
  };
  return Object.fromEntries(
    Object.entries(allowed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  ) as NodeJS.ProcessEnv;
}

function childEntry(): string | URL {
  const override = process.env.UNO_ENGINE_CHILD_ENTRY;
  if (process.env.VITEST === "true" && override) return resolve(override);
  return new URL("./isolated-entry.mjs", import.meta.url);
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

export type ResidentChildState = "starting" | "idle" | "busy" | "retired";

/** Receives the messages of the one job currently dispatched to a child. */
export type ChildJobListener = {
  onMessage(message: unknown): void;
  onExit(): void;
};

type ResidentChildOptions = {
  generation: number;
  heapMb: number;
  root: string;
  onLost(child: ResidentEngineChild): void;
};

/** One forked engine process that serves jobs one at a time. */
export class ResidentEngineChild {
  readonly generation: number;
  readonly heapMb: number;
  readonly root: string;
  readonly ready: Promise<void>;
  state: ResidentChildState = "starting";
  jobsCompleted = 0;
  idleTimer?: NodeJS.Timeout;

  private readonly child: ChildProcess;
  private readonly exited: Promise<void>;
  private listener?: ChildJobListener;

  constructor(options: ResidentChildOptions) {
    this.generation = options.generation;
    this.heapMb = options.heapMb;
    this.root = options.root;
    this.child = fork(childEntry(), [], {
      cwd: process.cwd(),
      detached: process.platform !== "win32",
      env: childEnvironment(options.root),
      execArgv: [`--max-old-space-size=${options.heapMb}`, "--import", "tsx"],
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });

    let markExited: () => void = () => undefined;
    this.exited = new Promise<void>((resolvePromise) => {
      markExited = resolvePromise;
    });
    let markReady: () => void = () => undefined;
    let failReady: (error: Error) => void = () => undefined;
    this.ready = new Promise<void>((resolvePromise, reject) => {
      markReady = resolvePromise;
      failReady = reject;
    });
    // Callers that never await `ready` must not see an unhandled rejection.
    this.ready.catch(() => undefined);

    const spawnTimer = setTimeout(() => {
      failReady(new Error("engine_child_spawn_timeout"));
      void this.terminate();
    }, SPAWN_TIMEOUT_MS);
    spawnTimer.unref();

    this.child.on("message", (message: unknown) => {
      if (this.state === "starting") {
        clearTimeout(spawnTimer);
        if (isReadyMessage(message)) {
          this.state = "idle";
          markReady();
        } else {
          failReady(new Error("engine_child_protocol_violation"));
          void this.terminate();
        }
        return;
      }
      if (this.listener) {
        this.listener.onMessage(message);
        return;
      }
      // Nothing may arrive while no job is dispatched.
      void this.terminate();
    });
    this.child.on("error", () => {
      void this.terminate();
    });
    this.child.once("exit", () => {
      clearTimeout(spawnTimer);
      const wasStarting = this.state === "starting";
      this.state = "retired";
      if (this.idleTimer) clearTimeout(this.idleTimer);
      markExited();
      if (wasStarting) failReady(new Error("engine_child_exited"));
      const listener = this.listener;
      this.listener = undefined;
      listener?.onExit();
      options.onLost(this);
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get alive(): boolean {
    return this.state !== "retired" && this.child.exitCode === null && this.child.signalCode === null;
  }

  attach(listener: ChildJobListener) {
    this.listener = listener;
  }

  detach() {
    this.listener = undefined;
  }

  send(message: unknown): Promise<void> {
    return new Promise<void>((resolvePromise, reject) => {
      try {
        this.child.send(message as Parameters<ChildProcess["send"]>[0], (error) => {
          if (error) reject(error);
          else resolvePromise();
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error("engine_child_send_failed"));
      }
    });
  }

  /** A referenced child (busy, or awaited by a job) keeps the parent event loop alive. */
  setReferenced(referenced: boolean) {
    if (!this.alive) return;
    if (referenced) {
      this.child.ref();
      this.child.channel?.ref();
    } else {
      this.child.unref();
      this.child.channel?.unref();
    }
  }

  /** SIGKILL of the whole process group, then waits briefly for the exit. */
  async terminate(): Promise<void> {
    const running = this.child.exitCode === null && this.child.signalCode === null;
    // Whoever awaits the termination must not see the event loop drain first.
    if (running) this.child.ref();
    // A dispatched job keeps its listener so it learns about the exit at once.
    this.state = "retired";
    if (this.idleTimer) clearTimeout(this.idleTimer);
    killProcessGroup(this.child);
    if (!running) return;
    let grace: NodeJS.Timeout | undefined;
    await Promise.race([
      this.exited,
      new Promise<void>((resolvePromise) => {
        grace = setTimeout(resolvePromise, TERMINATE_GRACE_MS);
      }),
    ]);
    clearTimeout(grace);
  }

  killSync() {
    this.state = "retired";
    killProcessGroup(this.child);
  }
}

function isReadyMessage(message: unknown) {
  return Boolean(message) && typeof message === "object" && (message as { type?: unknown }).type === "ready";
}

type Waiter = {
  heapMb: number;
  resolve(child: ResidentEngineChild): void;
  reject(error: Error): void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

type PoolRoot = { path: string; dev: number; ino: number };

export type EngineChildSnapshot = {
  pid: number | undefined;
  generation: number;
  jobsCompleted: number;
  state: ResidentChildState;
};

export type EngineChildPoolStats = {
  size: number;
  root: string | undefined;
  idle: number;
  busy: number;
  starting: number;
  waiting: number;
  generation: number;
  children: EngineChildSnapshot[];
};

export type EngineChildPoolOptions = {
  size: number;
  /** Parent directory of the pool root; defaults to `os.tmpdir()` at creation time. */
  tmpRoot?: string;
};

const livePools = new Set<EngineChildPool>();
let exitHookInstalled = false;

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const pool of livePools) pool.killSync();
  });
}

/** Roots owned by live pools of this process; abandoned-workspace recovery must skip them. */
export function liveEngineWorkspaceRoots(): string[] {
  return [...livePools].flatMap((pool) => {
    const root = pool.rootInfo();
    return root ? [root.path] : [];
  });
}

export function isLiveEngineWorkspaceRoot(directory: string, entry: { dev: number; ino: number }): boolean {
  const path = resolve(directory);
  for (const pool of livePools) {
    const root = pool.rootInfo();
    if (root && (root.path === path || (root.dev === entry.dev && root.ino === entry.ino))) return true;
  }
  return false;
}

export class EngineChildPool {
  readonly size: number;

  private readonly tmpRoot?: string;
  private root?: PoolRoot;
  private rootPromise?: Promise<string>;
  private readonly idle: ResidentEngineChild[] = [];
  private readonly busy = new Set<ResidentEngineChild>();
  private readonly starting = new Set<ResidentEngineChild>();
  /** Slots reserved while the pool root is being prepared for a spawn. */
  private readonly reservations = new Set<object>();
  private readonly waiters: Waiter[] = [];
  private desired = 0;
  private warming = 0;
  private generation = 0;
  private lastHeapMb?: number;
  private spawnFailures = 0;
  private retryTimer?: NodeJS.Timeout;
  private closed = false;

  constructor(options: EngineChildPoolOptions) {
    this.size = clamp(Math.trunc(options.size) || 1, 1, MAX_POOL_SIZE);
    this.tmpRoot = options.tmpRoot;
    livePools.add(this);
    installExitHook();
  }

  rootInfo(): PoolRoot | undefined {
    return this.root;
  }

  /** Creates (or re-creates, if it vanished) the private root of this pool. */
  async prepareRoot(): Promise<string> {
    if (this.closed) throw new Error("engine_pool_closed");
    const current = this.root;
    if (current) {
      try {
        const entry = await lstat(current.path);
        if (entry.isDirectory() && !entry.isSymbolicLink() && entry.ino === current.ino) return current.path;
      } catch {
        // Re-created below.
      }
      if (this.root === current) this.root = undefined;
    }
    this.rootPromise ??= (async () => {
      const path = await mkdtemp(join(this.tmpRoot ?? tmpdir(), ROOT_PREFIX));
      try {
        await chmod(path, 0o700);
        const entry = await lstat(path);
        if (this.closed) throw new Error("engine_pool_closed");
        this.root = { path: resolve(path), dev: entry.dev, ino: entry.ino };
        return this.root.path;
      } catch (error) {
        await rm(path, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    })().finally(() => {
      this.rootPromise = undefined;
    });
    return this.rootPromise;
  }

  /** Spawns children up to the pool size; resolves when those spawns are ready. */
  async warm(): Promise<void> {
    if (this.closed) throw new Error("engine_pool_closed");
    this.desired = this.size;
    // Whoever awaits the warm-up keeps the starting children referenced.
    this.warming += 1;
    try {
      const spawns = this.maintain();
      this.refreshReferences();
      const outcomes = await Promise.all(spawns);
      if (outcomes.includes(false)) throw new Error("engine_child_spawn_failed");
    } finally {
      this.warming -= 1;
      this.refreshReferences();
    }
  }

  /** Waits for an idle child with the requested heap; rejects when the signal aborts. */
  acquire(heapMb: number, signal?: AbortSignal): Promise<ResidentEngineChild> {
    return new Promise<ResidentEngineChild>((resolvePromise, reject) => {
      if (this.closed) {
        reject(new Error("engine_pool_closed"));
        return;
      }
      if (signal?.aborted) {
        reject(new Error("engine_acquire_aborted"));
        return;
      }
      const waiter: Waiter = { heapMb, resolve: resolvePromise, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error("engine_acquire_aborted"));
          this.refreshReferences();
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.lastHeapMb = heapMb;
      this.waiters.push(waiter);
      this.pump();
    });
  }

  /**
   * Returns a child after its job. With `retire` (or when the child is dead or
   * has served its quota) it is terminated and replaced in the background;
   * the returned promise resolves once the old process group is gone.
   */
  async release(child: ResidentEngineChild, options: { retire: boolean }): Promise<void> {
    this.busy.delete(child);
    child.jobsCompleted += 1;
    if (this.closed || options.retire || !child.alive || child.jobsCompleted >= maxJobsPerChild()) {
      const termination = child.terminate();
      this.pump();
      await termination;
      return;
    }
    this.makeIdle(child);
    this.pump();
    this.sampleIdleRss(child);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.desired = 0;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.reject(new Error("engine_pool_closed"));
    }
    const children = [...this.idle.splice(0), ...this.busy, ...this.starting];
    this.busy.clear();
    this.starting.clear();
    await Promise.all(children.map((child) => child.terminate()));
    await this.rootPromise?.catch(() => undefined);
    const root = this.root;
    this.root = undefined;
    livePools.delete(this);
    if (root) await rm(root.path, { recursive: true, force: true });
  }

  /** Synchronous teardown for `process.on("exit")`. */
  killSync() {
    for (const child of [...this.idle, ...this.busy, ...this.starting]) child.killSync();
    const root = this.root;
    if (!root) return;
    try {
      rmSync(root.path, { recursive: true, force: true });
    } catch {
      // Recovered later by the retention worker.
    }
  }

  stats(): EngineChildPoolStats {
    const children = [...this.starting, ...this.idle, ...this.busy];
    return {
      size: this.size,
      root: this.root?.path,
      idle: this.idle.length,
      busy: this.busy.size,
      starting: this.starting.size,
      waiting: this.waiters.length,
      generation: this.generation,
      children: children.map((child) => ({
        pid: child.pid,
        generation: child.generation,
        jobsCompleted: child.jobsCompleted,
        state: child.state,
      })),
    };
  }

  private alive() {
    return this.idle.length + this.busy.size + this.starting.size + this.reservations.size;
  }

  private pump() {
    if (this.closed) return;
    while (this.waiters.length > 0 && this.idle.length > 0) {
      const waiter = this.waiters[0];
      const index = this.idle.findIndex((child) => child.heapMb === waiter.heapMb && child.alive);
      if (index < 0) {
        // Free the slot for a child with the requested heap.
        const stale = this.idle.shift() as ResidentEngineChild;
        void stale.terminate();
        continue;
      }
      const [child] = this.idle.splice(index, 1);
      this.waiters.shift();
      if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
      if (child.idleTimer) clearTimeout(child.idleTimer);
      child.state = "busy";
      this.busy.add(child);
      waiter.resolve(child);
    }
    this.desired = Math.min(this.size, Math.max(this.desired, this.busy.size + this.waiters.length));
    this.maintain();
    this.refreshReferences();
  }

  private maintain(): Promise<boolean>[] {
    const spawns: Promise<boolean>[] = [];
    if (this.closed || this.retryTimer) return spawns;
    while (this.alive() < this.desired) spawns.push(this.spawnOne());
    return spawns;
  }

  private spawnOne(): Promise<boolean> {
    const generation = ++this.generation;
    const heapMb = this.waiters[0]?.heapMb ?? this.lastHeapMb ?? 256;
    // Reserve the slot synchronously so concurrent pumps do not over-spawn.
    const placeholder = {};
    this.reservations.add(placeholder);
    return (async () => {
      let child: ResidentEngineChild | undefined;
      try {
        const root = await this.prepareRoot();
        this.reservations.delete(placeholder);
        if (this.closed) return false;
        child = new ResidentEngineChild({ generation, heapMb, root, onLost: (lost) => this.onLost(lost) });
        this.starting.add(child);
        this.refreshReferences();
        await child.ready;
        this.starting.delete(child);
        if (this.closed || !child.alive) {
          await child.terminate();
          return false;
        }
        this.spawnFailures = 0;
        this.makeIdle(child);
        this.pump();
        return true;
      } catch {
        this.reservations.delete(placeholder);
        if (child) {
          this.starting.delete(child);
          void child.terminate();
        }
        this.onSpawnFailure();
        return false;
      }
    })();
  }

  private onSpawnFailure() {
    if (this.closed) return;
    this.spawnFailures += 1;
    // Jobs fail fast instead of waiting for their deadline; only in-flight spawns can still serve them.
    const unserved = this.waiters.length - this.starting.size - this.reservations.size;
    for (const waiter of this.waiters.splice(0, Math.max(0, unserved))) {
      if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.reject(new Error("engine_child_spawn_failed"));
    }
    if (this.retryTimer) return;
    const delay = RESPAWN_BACKOFF_MS[Math.min(this.spawnFailures, RESPAWN_BACKOFF_MS.length) - 1];
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.pump();
    }, delay);
    this.refreshReferences();
  }

  private makeIdle(child: ResidentEngineChild) {
    child.state = "idle";
    this.idle.push(child);
    if (child.idleTimer) clearTimeout(child.idleTimer);
    child.idleTimer = setTimeout(() => {
      const index = this.idle.indexOf(child);
      if (index < 0) return;
      this.idle.splice(index, 1);
      // Idle retirement does not respawn: the next acquire does.
      this.desired = Math.max(0, this.desired - 1);
      void child.terminate();
    }, idleRetirementMs());
    child.idleTimer.unref();
  }

  private sampleIdleRss(child: ResidentEngineChild) {
    const pid = child.pid;
    if (process.platform === "win32" || !pid) return;
    void processGroupRssReader()
      .then((read) => read(pid))
      .then((rssKb) => {
        const index = this.idle.indexOf(child);
        if (index < 0 || rssKb <= idleRssLimitKb()) return;
        this.idle.splice(index, 1);
        void child.terminate();
        this.pump();
      }, () => undefined);
  }

  private onLost(child: ResidentEngineChild) {
    const index = this.idle.indexOf(child);
    if (index >= 0) {
      this.idle.splice(index, 1);
      this.pump();
    }
  }

  private refreshReferences() {
    const demand = this.waiters.length > 0 || this.warming > 0;
    for (const child of this.starting) child.setReferenced(demand);
    for (const child of this.idle) child.setReferenced(false);
    for (const child of this.busy) child.setReferenced(true);
    if (this.retryTimer) {
      if (demand) this.retryTimer.ref();
      else this.retryTimer.unref();
    }
  }
}
