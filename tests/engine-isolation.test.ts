import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { EngineError } from "@/engine/errors";
import {
  closeEngineChildPool,
  convertPdfIsolated,
  engineChildPoolStats,
  EngineIsolationError,
  warmEngineChildPool,
} from "@/engine/isolated";
import {
  processGroupFromProcStat,
  processGroupRssReader,
  readProcessGroupRssKbFromProc,
} from "@/engine/isolated-child";
import { openPdfRenderer } from "@/engine/render";
import type { ConversionResult, ProgressEvent } from "@/engine/types";
import { syntheticPdf } from "./fixtures/synthetic-pdf";

const SAFE_OUTPUT = { preset: "custom", widthMm: 100, heightMm: 210 } as const;

function hasSafeCode(code: string) {
  return (error: unknown) => error instanceof EngineError && error.code === code;
}

afterAll(closeEngineChildPool);

describe("isolated engine process", () => {
  it("converts a synthetic fixture and forwards progress in order", async () => {
    const events: ProgressEvent[] = [];
    const result = await convertPdfIsolated(
      await syntheticPdf({ additionalInformation: true }),
      SAFE_OUTPUT,
      "mercado-livre@1.0.0",
      (event) => { events.push(event); },
      { timeoutMs: 30_000, maxHeapMb: 256 },
    );

    expect(result.pageCount).toBe(1);
    expect(result.validation).toEqual({ contentPreserved: true, geometryValid: true, codesEquivalent: true });
    expect(events.map(({ stage }) => stage)).toEqual(["analyze", "detect", "extract", "layout", "compose", "validate"]);
  }, 35_000);

  it("reconstructs only a safe typed error from a child failure", async () => {
    const privateLookingBytes = new TextEncoder().encode("private-looking-input-that-must-not-escape");
    await expect(convertPdfIsolated(privateLookingBytes, SAFE_OUTPUT, undefined, undefined, { timeoutMs: 10_000 }))
      .rejects.toSatisfy(hasSafeCode("invalid_pdf"));
  }, 15_000);

  it("kills work that exceeds a short non-production deadline", async () => {
    const input = await syntheticPdf();
    await expect(convertPdfIsolated(input, SAFE_OUTPUT, undefined, undefined, { timeoutMs: 1 }))
      .rejects.toBeInstanceOf(EngineIsolationError);
  }, 10_000);

  it("kills the child and returns a safe error when progress handling fails", async () => {
    const input = await syntheticPdf();
    await expect(convertPdfIsolated(input, SAFE_OUTPUT, undefined, () => {
      throw new Error("caller detail must not cross the isolation boundary");
    }, { timeoutMs: 30_000 }))
      .rejects.toBeInstanceOf(EngineIsolationError);
  }, 35_000);

  it("drains asynchronous progress after the child sends its terminal result", async () => {
    const stages: ProgressEvent["stage"][] = [];
    const result = await convertPdfIsolated(
      await syntheticPdf({ additionalInformation: true }),
      SAFE_OUTPUT,
      "mercado-livre@1.0.0",
      async (event) => {
        stages.push(event.stage);
        if (event.stage === "validate") {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      },
      { timeoutMs: 30_000 },
    );

    expect(result.pageCount).toBe(1);
    expect(stages.at(-1)).toBe("validate");
  }, 35_000);
});

const STUB_ENTRY = fileURLToPath(new URL("./fixtures/engine-child-stub.mjs", import.meta.url));

function isRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits until the pool has exactly one ready child (other than `excludedPid`) and nothing starting. */
async function idleChild(excludedPid?: number) {
  const started = Date.now();
  while (Date.now() - started < 25_000) {
    const stats = engineChildPoolStats();
    if (stats && stats.idle === 1 && stats.starting === 0 && stats.busy === 0) {
      const child = stats.children.find(({ state }) => state === "idle");
      if (child?.pid && child.pid !== excludedPid) {
        return { pid: child.pid, generation: child.generation, jobsCompleted: child.jobsCompleted };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("pool did not settle on one idle child");
}

async function digitalConversion(options: { product?: { quantity: number; title: string; sku?: string } } = {}) {
  return convertPdfIsolated(
    await syntheticPdf({ additionalInformation: true }),
    SAFE_OUTPUT,
    "mercado-livre@1.0.0",
    undefined,
    { timeoutMs: 30_000, ...options },
  );
}

async function renderedFingerprint(result: ConversionResult) {
  const renderer = await openPdfRenderer(result.bytes);
  try {
    const bitmap = await renderer.render(1, 100, 0);
    return {
      width: bitmap.width,
      height: bitmap.height,
      rgba: createHash("sha256").update(bitmap.rgba).digest("hex"),
    };
  } finally {
    await renderer.close();
  }
}

function comparable(result: ConversionResult) {
  return {
    pageCount: result.pageCount,
    widthMm: result.widthMm,
    heightMm: result.heightMm,
    versions: result.versions,
    validation: result.validation,
    pages: result.pages,
  };
}

describe("resident engine child pool", () => {
  // Idle RSS of a warm child is platform dependent; reuse assertions must not
  // race the idle sample. The retirement rule has its own case below.
  beforeEach(() => {
    vi.stubEnv("UNO_ENGINE_CHILD_IDLE_RSS_MB", "1000000");
    return () => {
      vi.unstubAllEnvs();
    };
  });

  it("serves consecutive jobs from the same warm process", async () => {
    await closeEngineChildPool();
    await warmEngineChildPool();
    const before = await idleChild();

    await digitalConversion();
    await digitalConversion();

    const after = await idleChild();
    expect(after.pid).toBe(before.pid);
    expect(after.generation).toBe(before.generation);
    expect(after.jobsCompleted).toBe(before.jobsCompleted + 2);
  }, 60_000);

  it("keeps the child after a typed engine error", async () => {
    const before = await idleChild();
    const invalid = new TextEncoder().encode("not a pdf at all");
    await expect(convertPdfIsolated(invalid, SAFE_OUTPUT, undefined, undefined, { timeoutMs: 10_000 }))
      .rejects.toSatisfy(hasSafeCode("invalid_pdf"));
    expect((await idleChild()).pid).toBe(before.pid);

    await digitalConversion();
    expect((await idleChild()).pid).toBe(before.pid);
  }, 60_000);

  it("retires the child after an isolation failure and replaces it", async () => {
    const before = await idleChild();
    await expect(convertPdfIsolated(await syntheticPdf(), SAFE_OUTPUT, undefined, () => {
      throw new Error("caller failure");
    }, { timeoutMs: 30_000 })).rejects.toBeInstanceOf(EngineIsolationError);

    expect(isRunning(before.pid)).toBe(false);
    const after = await idleChild();
    expect(after.pid).not.toBe(before.pid);
    expect(after.generation).toBeGreaterThan(before.generation);

    const result = await digitalConversion();
    expect(result.validation.codesEquivalent).toBe(true);
    expect((await idleChild()).pid).toBe(after.pid);
  }, 60_000);

  it("drops a job whose deadline expires while it waits for a busy child", async () => {
    const before = await idleChild();
    const running = digitalConversion();
    const waiting = convertPdfIsolated(await syntheticPdf(), SAFE_OUTPUT, undefined, undefined, { timeoutMs: 50 });

    await expect(waiting).rejects.toBeInstanceOf(EngineIsolationError);
    expect((await running).pageCount).toBe(1);
    expect((await idleChild()).pid).toBe(before.pid);
  }, 60_000);

  it("does not let one job leak state into the next", async () => {
    await closeEngineChildPool();
    await warmEngineChildPool();
    const child = await idleChild();

    await convertPdfIsolated(
      await syntheticPdf({ fiscalSummary: true }),
      { preset: "100x150" },
      "mercado-livre@1.0.0",
      undefined,
      { timeoutMs: 30_000, product: { quantity: 3, title: "Produto sintético", sku: "SKU-1" } },
    );
    const reused = await digitalConversion();
    expect((await idleChild()).pid).toBe(child.pid);

    await closeEngineChildPool();
    const fresh = await digitalConversion();

    expect(comparable(reused)).toEqual(comparable(fresh));
    expect(await renderedFingerprint(reused)).toEqual(await renderedFingerprint(fresh));
  }, 90_000);

  it("leaves no job workspace behind and removes the root on close", async () => {
    await digitalConversion();
    await expect(convertPdfIsolated(new TextEncoder().encode("broken"), SAFE_OUTPUT, undefined, undefined, { timeoutMs: 10_000 }))
      .rejects.toBeInstanceOf(EngineError);
    const { pid } = await idleChild();
    const root = engineChildPoolStats()?.root;
    expect(root).toBeTruthy();
    const entry = await lstat(root as string);
    expect(entry.isDirectory()).toBe(true);
    if (process.platform !== "win32") expect(entry.mode & 0o777).toBe(0o700);
    expect((await readdir(root as string)).filter((name) => name.startsWith("job-"))).toEqual([]);

    await closeEngineChildPool();
    expect(isRunning(pid)).toBe(false);
    await expect(lstat(root as string)).rejects.toMatchObject({ code: "ENOENT" });
    expect(engineChildPoolStats()).toBeUndefined();
  }, 60_000);

  it("fails an in-flight job at once when the pool closes", async () => {
    await warmEngineChildPool();
    const { pid } = await idleChild();
    let started: () => void = () => undefined;
    const progressed = new Promise<void>((resolve) => {
      started = resolve;
    });
    const job = convertPdfIsolated(await syntheticPdf(), SAFE_OUTPUT, undefined, () => {
      started();
    }, { timeoutMs: 60_000 });
    const outcome = expect(job).rejects.toBeInstanceOf(EngineIsolationError);
    await progressed;
    const closedAt = Date.now();
    await closeEngineChildPool();

    await outcome;
    expect(Date.now() - closedAt).toBeLessThan(5_000);
    expect(isRunning(pid)).toBe(false);
  }, 60_000);

  it("swaps the process after UNO_ENGINE_CHILD_MAX_JOBS jobs", async () => {
    await closeEngineChildPool();
    vi.stubEnv("UNO_ENGINE_CHILD_MAX_JOBS", "1");
    try {
      await warmEngineChildPool();
      const first = await idleChild();
      await digitalConversion();
      const second = await idleChild();
      expect(second.pid).not.toBe(first.pid);
      expect(isRunning(first.pid)).toBe(false);
      await digitalConversion();
      expect((await idleChild()).pid).not.toBe(second.pid);
    } finally {
      await closeEngineChildPool();
    }
  }, 90_000);

  it("retires an idle child whose RSS sample exceeds UNO_ENGINE_CHILD_IDLE_RSS_MB", async () => {
    await closeEngineChildPool();
    await warmEngineChildPool();
    const before = await idleChild();
    vi.stubEnv("UNO_ENGINE_CHILD_IDLE_RSS_MB", "1");
    try {
      await digitalConversion();
      const after = await idleChild(before.pid);
      expect(after.generation).toBeGreaterThan(before.generation);
      expect(isRunning(before.pid)).toBe(false);
    } finally {
      await closeEngineChildPool();
    }
  }, 60_000);

  it("retires a child that breaks the message protocol", async () => {
    await closeEngineChildPool();
    vi.stubEnv("UNO_ENGINE_CHILD_ENTRY", STUB_ENTRY);
    try {
      await warmEngineChildPool();
      const stub = await idleChild();
      await expect(convertPdfIsolated(await syntheticPdf(), SAFE_OUTPUT, undefined, undefined, { timeoutMs: 10_000 }))
        .rejects.toBeInstanceOf(EngineIsolationError);
      expect(isRunning(stub.pid)).toBe(false);
    } finally {
      await closeEngineChildPool();
    }
  }, 30_000);
});

describe("process group RSS readers", () => {
  it("parses the process group even when the command name contains parentheses", () => {
    expect(processGroupFromProcStat("4242 (node (worker) x) S 1 4242 4242 0 -1 4194560")).toBe(4242);
    expect(processGroupFromProcStat("garbage")).toBeUndefined();
  });

  it("sums VmRSS of every process in the group from a /proc tree", async () => {
    const proc = await mkdtemp(join(tmpdir(), "uno-proc-test-"));
    try {
      const write = async (pid: number, processGroup: number, rss?: number) => {
        await mkdir(join(proc, String(pid)));
        await writeFile(join(proc, String(pid), "stat"), `${pid} (tess (x)) S 1 ${processGroup} ${processGroup} 0`);
        await writeFile(join(proc, String(pid), "status"), `Name:\tx\n${rss === undefined ? "" : `VmRSS:\t  ${rss} kB\n`}`);
      };
      await write(100, 100, 1_000);
      await write(101, 100, 250);
      await write(102, 100);
      await write(200, 200, 9_999);
      await mkdir(join(proc, "self"));
      expect(await readProcessGroupRssKbFromProc(100, proc)).toBe(1_250);
      expect(await readProcessGroupRssKbFromProc(300, proc)).toBe(0);
    } finally {
      await rm(proc, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux")("reads this process group from the real /proc", async () => {
    const ownGroup = processGroupFromProcStat(await readFile("/proc/self/stat", "utf8"));
    expect(ownGroup).toBeDefined();
    expect(await readProcessGroupRssKbFromProc(ownGroup as number)).toBeGreaterThan(0);
    expect(await processGroupRssReader()).toBe(readProcessGroupRssKbFromProc);
  });
});
