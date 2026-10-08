import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import { conversions, outboxEvents, subscriptions, templates, usagePeriods, usageReservations } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { listConversionHistory } from "@/server/conversions/history";
import { readConversion } from "@/server/conversions/read";
import {
  commitReprocessedConversion,
  recoverReprocessCommit,
  reprocessConversion,
  type ReprocessDependencies,
} from "@/server/conversions/reprocess";
import type { StorageGateway, StoredObjectHead } from "@/server/storage";

const USER = "00000000-0000-4000-8000-000000000001";
const ORG = "00000000-0000-4000-8000-000000000101";
const OTHER_ORG = "00000000-0000-4000-8000-000000000102";
const TEMPLATE = "00000000-0000-4000-8000-000000000201";
const SOURCE = "00000000-0000-4000-8000-000000000301";
const NOW = new Date("2026-10-07T12:00:00.000Z");
const PDF = Buffer.from("%PDF-1.7\nsynthetic history source\n%%EOF", "ascii");
const SHA = createHash("sha256").update(PDF).digest("hex");
const CURSOR_SECRET = "history-test-secret-with-at-least-thirty-two-characters";

const pglite = new PGlite();
const database = drizzle(pglite, { schema });

class MemoryStorage implements StorageGateway {
  readonly objects = new Map<string, Buffer>();
  readonly operations: string[] = [];
  signedSeconds: number[] = [];
  onRead?: () => Promise<void>;
  onHead?: () => Promise<void>;

  async signUpload() {
    return { url: "https://storage.test/upload", headers: {}, expiresAt: new Date(NOW.getTime() + 300_000) };
  }
  async signDownload(key: string, expiresInSeconds = 300) {
    this.signedSeconds.push(expiresInSeconds);
    return { url: `https://storage.test/${encodeURIComponent(key)}`, expiresAt: new Date(NOW.getTime() + expiresInSeconds * 1_000) };
  }
  async head(key: string): Promise<StoredObjectHead> {
    this.operations.push(`head:${key}`);
    const bytes = this.objects.get(key);
    if (!bytes) throw new AppError("upload_not_found", "missing", 404);
    await this.onHead?.();
    return { contentLength: bytes.length, contentType: "application/pdf" };
  }
  async getRange(key: string, maxBytes: number) { return (await this.read(key, maxBytes)).subarray(0, maxBytes); }
  async read(key: string, maxBytes: number) {
    this.operations.push(`read:${key}`);
    const bytes = this.objects.get(key);
    if (!bytes) throw new AppError("upload_not_found", "missing", 404);
    if (bytes.length > maxBytes) throw new AppError("file_too_large", "too large", 413);
    await this.onRead?.();
    return Buffer.from(bytes);
  }
  async putBytes(key: string, bytes: Buffer, _contentType: string, maxBytes: number) {
    this.operations.push(`put:${key}`);
    if (bytes.length > maxBytes) throw new Error("too large");
    this.objects.set(key, Buffer.from(bytes));
  }
  async copy(sourceKey: string, targetKey: string) {
    this.operations.push(`copy:${sourceKey}:${targetKey}`);
    const bytes = this.objects.get(sourceKey);
    if (!bytes) throw new AppError("upload_not_found", "missing", 404);
    this.objects.set(targetKey, Buffer.from(bytes));
  }
  async delete(key: string) {
    this.operations.push(`delete:${key}`);
    this.objects.delete(key);
  }
  async openReadStream(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) throw new AppError("upload_not_found", "missing", 404);
    return Readable.from([bytes]);
  }
  async beginMultipartUpload() { return "upload-id"; }
  async uploadPart() { return "etag"; }
  async completeMultipartUpload() {}
  async abortMultipartUpload() {}
}

const storage = new MemoryStorage();

async function applyMigrations() {
  const directory = fileURLToPath(new URL("../drizzle", import.meta.url));
  const names = (await readdir(directory)).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
  for (const name of names) {
    const migration = await readFile(`${directory}/${name}`, "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await pglite.exec(statement);
    }
  }
}

beforeAll(async () => {
  await applyMigrations();
  await database.insert(schema.user).values({ id: USER, name: "Synthetic", email: "history@example.test", emailVerified: true });
  await database.insert(schema.organizations).values([
    { id: ORG, name: "History", slug: "history", ownerUserId: USER },
    { id: OTHER_ORG, name: "Other", slug: "history-other", ownerUserId: USER },
  ]);
  await database.insert(templates).values({
    id: TEMPLATE,
    key: "mercado-livre",
    version: "1.0.0",
    displayName: "Mercado Livre",
    engineVersion: "0.1.0",
    status: "RELEASED",
    releasedAt: new Date("2026-10-01T00:00:00.000Z"),
    definition: { releasedSizes: [100, 250, 300].map((heightMm) => ({
      widthMm: 100,
      heightMm,
      automaticReportSha256: "a".repeat(64),
      physicalProofSha256: "b".repeat(64),
      approvedAt: "2026-10-01T00:00:00.000Z",
    })) },
  });
  await database.insert(subscriptions).values([
    { organizationId: ORG, planId: "FREE", status: "ACTIVE" },
    { organizationId: OTHER_ORG, planId: "FREE", status: "ACTIVE" },
  ]);
});

beforeEach(async () => {
  await database.delete(outboxEvents);
  await database.delete(conversions);
  await database.delete(usagePeriods);
  storage.objects.clear();
  storage.operations.length = 0;
  storage.signedSeconds.length = 0;
  storage.onRead = undefined;
  storage.onHead = undefined;
  await database.update(subscriptions).set({ planId: "FREE" }).where(eq(subscriptions.organizationId, ORG));
  await database.update(templates).set({ status: "RELEASED" }).where(eq(templates.id, TEMPLATE));
});

function errorChainMatches(error: unknown, pattern: RegExp): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (current instanceof Error && pattern.test(current.message)) return true;
    current = typeof current === "object" && "cause" in current
      ? (current as { cause?: unknown }).cause
      : undefined;
  }
  return false;
}

afterAll(() => pglite.close());

async function insertConversion(input: Partial<typeof conversions.$inferInsert> & { id: string }) {
  await database.insert(conversions).values({
    organizationId: ORG,
    templateId: TEMPLATE,
    templateVersion: "1.0.0",
    engineVersion: "0.1.0",
    status: "completed",
    source: "dashboard",
    progress: 100,
    outputPreset: "custom",
    outputWidthMm: "100",
    outputHeightMm: "250",
    inputObjectKey: `organizations/${ORG}/conversion-inputs/${input.id}.pdf`,
    inputSha256: SHA,
    outputObjectKey: `organizations/${ORG}/conversion-outputs/${input.id}.pdf`,
    sourceByteLength: PDF.length,
    originalFileName: "etiqueta.pdf",
    artifactsExpireAt: new Date(NOW.getTime() + 3_600_000),
    completedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...input,
  });
}

function ids() {
  const values = [
    "00000000-0000-4000-8000-000000000401",
    "00000000-0000-4000-8000-000000000402",
    "00000000-0000-4000-8000-000000000403",
    "00000000-0000-4000-8000-000000000404",
  ];
  return () => values.shift()!;
}

function reprocessDependencies(overrides: Partial<ReprocessDependencies> = {}): ReprocessDependencies {
  const deps: ReprocessDependencies = {
    database: database as never,
    storage,
    enforceRateLimit: vi.fn(async () => { storage.operations.push("rate-limit"); }),
    publish: vi.fn(async () => undefined),
    commit: (input) => commitReprocessedConversion(input, database as never),
    recoverCommit: (input) => recoverReprocessCommit(input, database as never),
    randomId: ids(),
    now: () => NOW,
    ...overrides,
  };
  return deps;
}

describe("conversion history", () => {
  it("uses stable descending cursor pagination bound to the literal filters", async () => {
    const entries = [
      ["00000000-0000-4000-8000-000000000311", "normal.pdf"],
      ["00000000-0000-4000-8000-000000000312", "literal%_name.pdf"],
      ["00000000-0000-4000-8000-000000000313", "literal%_name-2.pdf"],
    ] as const;
    for (const [id, originalFileName] of entries) await insertConversion({ id, originalFileName });
    await insertConversion({ id: "00000000-0000-4000-8000-000000000314", organizationId: OTHER_ORG });

    const first = await listConversionHistory(ORG, { q: "%_", limit: "1" }, {
      database: database as never,
      cursorSecret: CURSOR_SECRET,
      now: () => NOW,
    });
    expect(first.items.map((item) => item.id)).toEqual(["00000000-0000-4000-8000-000000000313"]);
    expect(first.nextCursor).toBeTruthy();
    expect(first.items[0]).not.toHaveProperty("download");

    const second = await listConversionHistory(ORG, { q: "%_", limit: "1", cursor: first.nextCursor! }, {
      database: database as never,
      cursorSecret: CURSOR_SECRET,
      now: () => NOW,
    });
    expect(second.items.map((item) => item.id)).toEqual(["00000000-0000-4000-8000-000000000312"]);
    await expect(listConversionHistory(ORG, { q: "different", limit: "1", cursor: first.nextCursor! }, {
      database: database as never,
      cursorSecret: CURSOR_SECRET,
      now: () => NOW,
    })).rejects.toMatchObject({ code: "invalid_cursor" });
  });

  it("applies inclusive from, exclusive to, status and source filters", async () => {
    await insertConversion({ id: "00000000-0000-4000-8000-000000000321", createdAt: new Date("2026-10-01T00:00:00Z") });
    await insertConversion({ id: "00000000-0000-4000-8000-000000000322", createdAt: new Date("2026-10-02T00:00:00Z"), source: "api" });
    await insertConversion({ id: "00000000-0000-4000-8000-000000000323", createdAt: new Date("2026-10-03T00:00:00Z"), status: "failed" });
    const result = await listConversionHistory(ORG, {
      source: "api",
      status: "completed",
      from: "2026-10-02T00:00:00Z",
      to: "2026-10-03T00:00:00Z",
    }, { database: database as never, cursorSecret: CURSOR_SECRET, now: () => NOW });
    expect(result.items.map((item) => item.id)).toEqual(["00000000-0000-4000-8000-000000000322"]);
  });

  it("signs retained detail artifacts for no longer than the remaining retention", async () => {
    const id = "00000000-0000-4000-8000-000000000324";
    await insertConversion({ id, artifactsExpireAt: new Date(NOW.getTime() + 120_500) });
    storage.objects.set(`organizations/${ORG}/conversion-inputs/${id}.pdf`, PDF);
    storage.objects.set(`organizations/${ORG}/conversion-outputs/${id}.pdf`, PDF);
    const view = await readConversion(ORG, id, { database: database as never, storage, now: () => NOW });
    expect(view.download?.url).toMatch(/^https:/);
    expect(view.original?.url).toMatch(/^https:/);
    expect(storage.signedSeconds).toEqual([120, 120]);

    storage.objects.delete(`organizations/${ORG}/conversion-outputs/${id}.pdf`);
    await expect(readConversion(ORG, id, { database: database as never, storage, now: () => NOW }))
      .rejects.toMatchObject({ code: "artifact_unavailable", status: 410 });
  });

  it("does not sign when retention expires while object metadata is being checked", async () => {
    const id = "00000000-0000-4000-8000-000000000325";
    const expiresAt = new Date(NOW.getTime() + 2_000);
    await insertConversion({ id, artifactsExpireAt: expiresAt });
    storage.objects.set(`organizations/${ORG}/conversion-inputs/${id}.pdf`, PDF);
    storage.objects.set(`organizations/${ORG}/conversion-outputs/${id}.pdf`, PDF);
    let current = NOW;
    storage.onHead = async () => { current = new Date(expiresAt.getTime() + 1); };
    const view = await readConversion(ORG, id, { database: database as never, storage, now: () => current });
    expect(view.download).toBeUndefined();
    expect(view.original).toBeUndefined();
    expect(storage.signedSeconds).toHaveLength(0);
  });
});

describe("conversion reprocessing", () => {
  async function source(overrides: Partial<typeof conversions.$inferInsert> = {}) {
    await insertConversion({ id: SOURCE, ...overrides });
    storage.objects.set(`organizations/${ORG}/conversion-inputs/${SOURCE}.pdf`, PDF);
  }

  it("copies immutable bytes, reserves a new unit and deduplicates the same effective request", async () => {
    await source();
    const deps = reprocessDependencies();
    const key = "reprocess-key-0001";
    const first = await reprocessConversion(
      { organizationId: ORG, userId: USER, planId: "FREE" },
      SOURCE,
      key,
      {},
      deps,
    );
    const second = await reprocessConversion(
      { organizationId: ORG, userId: USER, planId: "FREE" },
      SOURCE,
      key,
      { template: "mercado-livre@1.0.0", size: { preset: "custom", widthMm: 100, heightMm: 250 } },
      deps,
    );
    expect(second.id).toBe(first.id);
    expect(storage.operations[0]).toBe("rate-limit");
    expect(storage.operations.filter((entry) => entry.startsWith("put:"))).toHaveLength(1);
    const rows = await database.select({ sourceId: conversions.sourceConversionId, key: conversions.inputObjectKey })
      .from(conversions).where(eq(conversions.id, first.id));
    expect(rows[0]?.sourceId).toBe(SOURCE);
    expect(rows[0]?.key).not.toBe(`organizations/${ORG}/conversion-inputs/${SOURCE}.pdf`);
    expect(storage.objects.get(`organizations/${ORG}/conversion-inputs/${SOURCE}.pdf`)).toEqual(PDF);
    const counters = await database.select({ reserved: usagePeriods.reserved, confirmed: usagePeriods.confirmed }).from(usagePeriods);
    expect(counters).toEqual([{ reserved: 1, confirmed: 0 }]);
    expect(await database.select().from(usageReservations)).toHaveLength(1);
    expect(await database.select().from(outboxEvents)).toHaveLength(1);
  });

  it("returns a conflict when a key is reused with different effective parameters", async () => {
    await source();
    const deps = reprocessDependencies();
    await reprocessConversion({ organizationId: ORG, userId: USER, planId: "FREE" }, SOURCE, "reprocess-key-0002", {}, deps);
    await expect(reprocessConversion(
      { organizationId: ORG, userId: USER, planId: "FREE" },
      SOURCE,
      "reprocess-key-0002",
      { size: { preset: "custom", widthMm: 100, heightMm: 300 } },
      deps,
    )).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
  });

  it.each([
    ["queued", new Date(NOW.getTime() + 60_000), "conversion_active"],
    ["processing", new Date(NOW.getTime() + 60_000), "conversion_active"],
    ["failed", NOW, "source_unavailable"],
  ] as const)("rejects %s or expired sources before object access", async (status, artifactsExpireAt, code) => {
    await source({ status, artifactsExpireAt, ...(status === "processing" ? {
      processingToken: "token",
      processingLeaseExpiresAt: new Date(NOW.getTime() + 60_000),
    } : {}) });
    await expect(reprocessConversion(
      { organizationId: ORG, userId: USER, planId: "FREE" }, SOURCE, `reprocess-${status}-key`, {}, reprocessDependencies(),
    )).rejects.toMatchObject({ code });
    expect(storage.operations.some((entry) => entry.startsWith("read:"))).toBe(false);
  });

  it("maps a missing retained source object to a safe gone response", async () => {
    await source();
    storage.objects.clear();
    await expect(reprocessConversion(
      { organizationId: ORG, userId: USER, planId: "FREE" }, SOURCE, "reprocess-missing-key", {}, reprocessDependencies(),
    )).rejects.toMatchObject({ code: "source_unavailable", status: 410 });
  });

  it("reconciles a lost commit acknowledgement without deleting the committed copy", async () => {
    await source();
    const deps = reprocessDependencies();
    deps.commit = async (input) => {
      await commitReprocessedConversion(input, database as never);
      throw new Error("lost commit acknowledgement");
    };
    const result = await reprocessConversion(
      { organizationId: ORG, userId: USER, planId: "FREE" }, SOURCE, "reprocess-commit-key", {}, deps,
    );
    expect(result.status).toBe("queued");
    expect(storage.operations.filter((entry) => entry.startsWith("delete:"))).toHaveLength(0);
    expect(await database.select().from(usageReservations)).toHaveLength(1);
  });

  it("preserves a potential committed copy when database recovery is unavailable", async () => {
    await source();
    const deps = reprocessDependencies({
      commit: vi.fn(async () => { throw new Error("connection lost"); }),
      recoverCommit: vi.fn(async () => { throw new Error("database unavailable"); }),
    });
    await expect(reprocessConversion(
      { organizationId: ORG, userId: USER, planId: "FREE" }, SOURCE, "reprocess-unknown-key", {}, deps,
    )).rejects.toThrow("connection lost");
    expect(storage.operations.filter((entry) => entry.startsWith("delete:"))).toHaveLength(0);
    expect(storage.objects.size).toBe(2);
  });

  it("rechecks the current plan after reading the retained source", async () => {
    const large = Buffer.alloc(5 * 1_024 * 1_024 + 1, 1);
    const sha = createHash("sha256").update(large).digest("hex");
    await database.update(subscriptions).set({
      planId: "BUSINESS",
      status: "ACTIVE",
      currentPeriodStart: new Date(NOW.getTime() - 60_000),
      currentPeriodEnd: new Date(NOW.getTime() + 60 * 60_000),
    }).where(eq(subscriptions.organizationId, ORG));
    await insertConversion({
      id: SOURCE,
      sourceByteLength: large.length,
      inputSha256: sha,
    });
    storage.objects.set(`organizations/${ORG}/conversion-inputs/${SOURCE}.pdf`, large);
    storage.onRead = async () => {
      await database.update(subscriptions).set({ planId: "FREE", currentPeriodStart: null, currentPeriodEnd: null }).where(eq(subscriptions.organizationId, ORG));
    };
    await expect(reprocessConversion(
      { organizationId: ORG, userId: USER, planId: "BUSINESS" }, SOURCE, "reprocess-plan-change", {}, reprocessDependencies(),
    )).rejects.toMatchObject({ code: "file_too_large", status: 413 });
    expect(storage.operations.some((entry) => entry.startsWith("delete:"))).toBe(true);
    expect(await database.select().from(usageReservations)).toHaveLength(0);
  });

  it("rechecks template release after reading the retained source", async () => {
    await source();
    storage.onRead = async () => {
      await database.update(templates).set({ status: "RETIRED" }).where(eq(templates.id, TEMPLATE));
    };
    await expect(reprocessConversion(
      { organizationId: ORG, userId: USER, planId: "FREE" }, SOURCE, "reprocess-template-change", {}, reprocessDependencies(),
    )).rejects.toMatchObject({ code: "template_not_released", status: 409 });
    expect(storage.operations.some((entry) => entry.startsWith("delete:"))).toBe(true);
    expect(await database.select().from(usageReservations)).toHaveLength(0);
  });

  it("rechecks source expiry after acquiring the commit lock", async () => {
    await source({ artifactsExpireAt: new Date(NOW.getTime() + 1_000) });
    const moments = [NOW, new Date(NOW.getTime() + 2_000)];
    const deps = reprocessDependencies({ now: () => moments.shift() ?? moments.at(-1)! });
    await expect(reprocessConversion(
      { organizationId: ORG, userId: USER, planId: "FREE" }, SOURCE, "reprocess-expiry-race", {}, deps,
    )).rejects.toMatchObject({ code: "source_unavailable", status: 410 });
    expect(storage.operations.some((entry) => entry.startsWith("delete:"))).toBe(true);
    expect(await database.select().from(usageReservations)).toHaveLength(0);
  });
});

describe("phase 7 schema", () => {
  it("enforces tenant-scoped source references and idempotency", async () => {
    await insertConversion({ id: SOURCE });
    await expect(insertConversion({
      id: "00000000-0000-4000-8000-000000000389",
      sourceConversionId: SOURCE,
    })).rejects.toSatisfy((error: unknown) => errorChainMatches(error, /conversions_reprocess_idempotency_ck|check constraint/i));
    await expect(insertConversion({
      id: "00000000-0000-4000-8000-000000000390",
      organizationId: OTHER_ORG,
      sourceConversionId: SOURCE,
      reprocessIdempotencyKey: "schema-idempotency-1",
      reprocessRequestHash: "a".repeat(64),
    })).rejects.toSatisfy((error: unknown) => errorChainMatches(error, /conversions_org_source_conversion_fk|foreign key/i));
    await insertConversion({
      id: "00000000-0000-4000-8000-000000000391",
      sourceConversionId: SOURCE,
      reprocessIdempotencyKey: "schema-idempotency-1",
      reprocessRequestHash: "a".repeat(64),
    });
    await expect(insertConversion({
      id: "00000000-0000-4000-8000-000000000392",
      sourceConversionId: SOURCE,
      reprocessIdempotencyKey: "schema-idempotency-1",
      reprocessRequestHash: "a".repeat(64),
    })).rejects.toSatisfy((error: unknown) => errorChainMatches(error, /conversions_reprocess_idempotency_uq|unique/i));
  });
});
