import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import {
  batches,
  conversionPages,
  conversions,
  outboxEvents,
  processingEvents,
  subscriptions,
  templates,
  uploadIntents,
  usagePeriods,
  usageReservations,
  type UnoDatabase,
} from "@/db";
import { recoverAbandonedEngineWorkspaces } from "@/engine/isolated";
import { EngineChildPool, liveEngineWorkspaceRoots } from "@/engine/isolated-child";
import { AppError } from "@/lib/errors";
import { listBatchItems, listBatches, readBatch, reconcileBatch, signBatchDownload } from "@/server/batches";
import { listConversionHistory } from "@/server/conversions/history";
import { readConversion } from "@/server/conversions/read";
import { commitReprocessedConversion, recoverReprocessCommit, reprocessConversion } from "@/server/conversions/reprocess";
import {
  cleanupExpiredBatches,
  cleanupExpiredConversions,
  cleanupExpiredUploadIntents,
  collectOrphanCandidate,
  readRetentionConfig,
  RetentionConfigError,
  runRetentionCycle,
  type RetentionDependencies,
} from "@/server/retention";
import type { StorageGateway, StoredObjectHead } from "@/server/storage";
import { startRetentionWorker } from "@/workers/retention-worker";

const USER = "00000000-0000-4000-8000-000000000001";
const ORG = "00000000-0000-4000-8000-000000000101";
const TEMPLATE = "00000000-0000-4000-8000-000000000201";
const PERIOD = "00000000-0000-4000-8000-000000000501";
const NOW = new Date("2026-10-07T12:00:00.000Z");
const EXPIRED = new Date(NOW.getTime() - 60_000);
const LEASE_MS = 300_000;
const PDF = Buffer.from("%PDF-1.7\nsynthetic retention fixture\n%%EOF", "ascii");
const SHA = "a".repeat(64);

const pglite = new PGlite();
const database = drizzle(pglite, { schema }) as unknown as UnoDatabase;

class MemoryStorage implements StorageGateway {
  readonly objects = new Map<string, Buffer>();
  readonly deletes: string[] = [];
  failDeletes = new Set<string>();
  onDelete?: (key: string) => Promise<void>;
  onHead?: () => Promise<void>;

  async signUpload() { return { url: "https://storage.test/upload", headers: {}, expiresAt: new Date(NOW.getTime() + 300_000) }; }
  async signDownload(key: string, expiresInSeconds = 300) {
    return { url: `https://storage.test/${encodeURIComponent(key)}`, expiresAt: new Date(NOW.getTime() + expiresInSeconds * 1_000) };
  }
  async head(key: string): Promise<StoredObjectHead> {
    const bytes = this.objects.get(key);
    if (!bytes) throw new AppError("upload_not_found", "missing", 404);
    await this.onHead?.();
    return { contentLength: bytes.length, contentType: "application/pdf" };
  }
  async getRange(key: string, maxBytes: number) { return (await this.read(key)).subarray(0, maxBytes); }
  async read(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) throw new AppError("upload_not_found", "missing", 404);
    return Buffer.from(bytes);
  }
  async putBytes(key: string, bytes: Buffer) { this.objects.set(key, Buffer.from(bytes)); }
  async copy(sourceKey: string, targetKey: string) {
    const bytes = this.objects.get(sourceKey);
    if (!bytes) throw new AppError("upload_not_found", "missing", 404);
    this.objects.set(targetKey, Buffer.from(bytes));
  }
  async delete(key: string) {
    this.deletes.push(key);
    await this.onDelete?.(key);
    if (this.failDeletes.has(key)) throw new AppError("service_unavailable", "unavailable", 503);
    this.objects.delete(key);
  }
  async openReadStream(key: string) { return Readable.from([await this.read(key)]); }
  async beginMultipartUpload() { return "upload-id"; }
  async uploadPart() { return "etag"; }
  async completeMultipartUpload() {}
  async abortMultipartUpload() {}
}

const storage = new MemoryStorage();

function deps(overrides: Partial<RetentionDependencies> = {}): RetentionDependencies {
  return { database, storage, randomId: randomUUID, now: () => NOW, leaseMs: LEASE_MS, ...overrides };
}

const inputKey = (id: string) => `organizations/${ORG}/conversion-inputs/${id}.pdf`;
const outputKey = (id: string, token = "committed") => `organizations/${ORG}/conversion-outputs/${id}/${token}.pdf`;

async function insertConversion(input: Partial<typeof conversions.$inferInsert> = {}) {
  const id = input.id ?? randomUUID();
  await database.insert(conversions).values({
    id,
    organizationId: ORG,
    createdByUserId: USER,
    templateId: TEMPLATE,
    templateVersion: "1.0.0",
    engineVersion: "0.1.0",
    status: "completed",
    source: "dashboard",
    progress: 100,
    outputPreset: "custom",
    outputWidthMm: "100",
    outputHeightMm: "250",
    inputObjectKey: inputKey(id),
    inputSha256: SHA,
    outputObjectKey: outputKey(id),
    sourceByteLength: PDF.length,
    originalFileName: "cliente-sintetico.pdf",
    artifactsExpireAt: EXPIRED,
    completedAt: EXPIRED,
    createdAt: EXPIRED,
    updatedAt: EXPIRED,
    ...input,
  });
  const row = (await database.select().from(conversions).where(eq(conversions.id, id)))[0]!;
  storage.objects.set(row.inputObjectKey, PDF);
  if (row.outputObjectKey) storage.objects.set(row.outputObjectKey, PDF);
  return row;
}

async function reserve(conversionId: string, status: "RESERVED" | "CONFIRMED") {
  await database.insert(usagePeriods).values({
    id: PERIOD,
    organizationId: ORG,
    periodStart: new Date("2026-10-01T00:00:00.000Z"),
    periodEnd: new Date("2026-11-01T00:00:00.000Z"),
    limit: 10,
    reserved: status === "RESERVED" ? 1 : 0,
    confirmed: status === "CONFIRMED" ? 1 : 0,
  });
  await database.insert(usageReservations).values({
    organizationId: ORG,
    usagePeriodId: PERIOD,
    conversionId,
    status,
    ...(status === "CONFIRMED" ? { confirmedAt: EXPIRED } : {}),
  });
}

async function conversion(id: string) {
  return (await database.select().from(conversions).where(eq(conversions.id, id)))[0]!;
}

async function batch(id: string) {
  return (await database.select().from(batches).where(eq(batches.id, id)))[0]!;
}

async function insertBatch(input: Partial<typeof batches.$inferInsert> = {}) {
  const id = input.id ?? randomUUID();
  await database.insert(batches).values({
    id,
    organizationId: ORG,
    createdByUserId: USER,
    status: "completed",
    phase: "completed",
    itemCount: 2,
    completedCount: 1,
    failedCount: 1,
    progress: 100,
    archiveStatus: "READY",
    zipObjectKey: `organizations/${ORG}/batch-archives/${id}/published/uno-lote-${id}.zip`,
    zipByteLength: PDF.length,
    artifactsExpireAt: EXPIRED,
    completedAt: EXPIRED,
    createdAt: EXPIRED,
    updatedAt: EXPIRED,
    ...input,
  });
  const row = await batch(id);
  if (row.zipObjectKey) storage.objects.set(row.zipObjectKey, PDF);
  return row;
}

async function batchChildren(batchId: string, artifactsExpireAt = EXPIRED) {
  const completed = await insertConversion({ batchId, artifactsExpireAt });
  const failed = await insertConversion({
    batchId, artifactsExpireAt, status: "failed", outputObjectKey: null, errorCode: "invalid_pdf", errorMessage: "Arquivo inválido.",
  });
  return { completed, failed };
}

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
  await database.insert(schema.user).values({ id: USER, name: "Synthetic", email: "retention@example.test", emailVerified: true });
  await database.insert(schema.organizations).values({ id: ORG, name: "Retention", slug: "retention", ownerUserId: USER });
  await database.insert(templates).values({
    id: TEMPLATE,
    key: "mercado-livre",
    version: "1.0.0",
    displayName: "Mercado Livre",
    engineVersion: "0.1.0",
    status: "RELEASED",
    releasedAt: new Date("2026-10-01T00:00:00.000Z"),
    definition: {},
  });
  await database.insert(subscriptions).values({ organizationId: ORG, planId: "FREE", status: "ACTIVE" });
});

beforeEach(async () => {
  await database.delete(outboxEvents);
  await database.delete(usageReservations);
  await database.delete(conversions);
  await database.delete(batches);
  await database.delete(uploadIntents);
  await database.delete(usagePeriods);
  storage.objects.clear();
  storage.deletes.length = 0;
  storage.failDeletes = new Set();
  storage.onDelete = undefined;
  storage.onHead = undefined;
});

afterAll(() => pglite.close());

describe("conversion retention", () => {
  it("tombstones an expired conversion, keeps accounting and is idempotent", async () => {
    const intentId = randomUUID();
    const intentKey = `organizations/${ORG}/uploads/${intentId}.pdf`;
    await database.insert(uploadIntents).values({
      id: intentId, organizationId: ORG, createdByUserId: USER, objectKey: intentKey, contentLength: PDF.length,
      originalFileName: "cliente-sintetico.pdf", expiresAt: EXPIRED, consumedAt: EXPIRED,
    });
    storage.objects.set(intentKey, PDF);
    const row = await insertConversion({ uploadIntentId: intentId, sourceConversionId: null });
    await reserve(row.id, "CONFIRMED");
    await database.insert(conversionPages).values({
      organizationId: ORG, conversionId: row.id, pageNumber: 1, role: "logistics", kind: "digital", widthPoints: "283.465", heightPoints: "425.197",
    });
    await database.insert(processingEvents).values({ organizationId: ORG, conversionId: row.id, stage: "completed", progress: 100, attempt: 1 });
    const kept = await insertConversion({ artifactsExpireAt: new Date(NOW.getTime() + 60_000) });

    expect(await cleanupExpiredConversions(deps(), 10)).toEqual({ deleted: 1, deferred: 0, failed: 0 });

    const tombstone = await conversion(row.id);
    expect(tombstone).toMatchObject({
      status: "deleted", originalFileName: null, retentionToken: null, retentionLeaseExpiresAt: null,
      organizationId: ORG, source: "dashboard", uploadIntentId: intentId, inputSha256: SHA, templateId: TEMPLATE,
    });
    expect(tombstone.deletedAt?.toISOString()).toBe(NOW.toISOString());
    expect([...storage.objects.keys()].sort()).toEqual([kept.inputObjectKey, kept.outputObjectKey].sort());
    expect((await database.select().from(usageReservations))[0]?.status).toBe("CONFIRMED");
    expect((await database.select().from(usagePeriods))[0]).toMatchObject({ confirmed: 1, reserved: 0 });
    expect(await database.select().from(conversionPages)).toHaveLength(1);
    expect(await database.select().from(processingEvents)).toHaveLength(1);
    expect((await database.select().from(uploadIntents))[0]?.originalFileName).toBeNull();
    expect((await conversion(kept.id)).status).toBe("completed");

    const before = storage.deletes.length;
    expect(await cleanupExpiredConversions(deps(), 10)).toEqual({ deleted: 0, deferred: 0, failed: 0 });
    expect(storage.deletes).toHaveLength(before);
  });

  it("keeps a partially deleted conversion recoverable and confirms only after every delete", async () => {
    const row = await insertConversion();
    storage.failDeletes.add(row.outputObjectKey!);

    expect(await cleanupExpiredConversions(deps(), 10)).toEqual({ deleted: 0, deferred: 0, failed: 1 });
    let current = await conversion(row.id);
    expect(current.status).toBe("deleting");
    expect(current.deletedAt).toBeNull();
    expect(current.originalFileName).toBe("cliente-sintetico.pdf");
    expect(current.retentionLeaseExpiresAt?.getTime()).toBe(NOW.getTime() + LEASE_MS);
    expect(storage.objects.has(row.inputObjectKey)).toBe(false);
    expect(storage.objects.has(row.outputObjectKey!)).toBe(true);

    const attempts = storage.deletes.length;
    await cleanupExpiredConversions(deps(), 10);
    expect(storage.deletes).toHaveLength(attempts);

    storage.failDeletes.clear();
    const later = new Date(NOW.getTime() + LEASE_MS + 1);
    expect(await cleanupExpiredConversions(deps({ now: () => later }), 10)).toEqual({ deleted: 1, deferred: 0, failed: 0 });
    current = await conversion(row.id);
    expect(current.status).toBe("deleted");
    expect(current.deletedAt?.getTime()).toBe(later.getTime());
    expect(storage.objects.size).toBe(0);
  });

  it("never deletes under a valid processing lease and fences the attempt once it lapses", async () => {
    const token = randomUUID();
    const row = await insertConversion({
      status: "processing", progress: 40, outputObjectKey: null, completedAt: null, attempts: 1,
      processingToken: token, processingLeaseExpiresAt: new Date(NOW.getTime() + 30_000),
    });
    await reserve(row.id, "RESERVED");
    const attemptKey = outputKey(row.id, token);
    storage.objects.set(attemptKey, PDF);

    expect(await cleanupExpiredConversions(deps(), 10)).toEqual({ deleted: 0, deferred: 1, failed: 0 });
    expect(storage.deletes).toHaveLength(0);
    expect(await conversion(row.id)).toMatchObject({ status: "processing", processingToken: token, retentionToken: null });
    expect((await database.select().from(usageReservations))[0]?.status).toBe("RESERVED");

    const later = new Date(NOW.getTime() + 31_000);
    expect(await cleanupExpiredConversions(deps({ now: () => later }), 10)).toEqual({ deleted: 1, deferred: 0, failed: 0 });
    expect(await conversion(row.id)).toMatchObject({ status: "deleted", processingToken: null, processingLeaseExpiresAt: null });
    expect(storage.objects.size).toBe(0);
    expect(storage.deletes).toContain(attemptKey);
    expect((await database.select().from(usageReservations))[0]?.status).toBe("RELEASED");
    expect((await database.select().from(usagePeriods))[0]).toMatchObject({ confirmed: 0, reserved: 0 });
  });

  it("lets only one of two concurrent retention claims delete and confirm", async () => {
    const row = await insertConversion();
    const results = await Promise.all([cleanupExpiredConversions(deps(), 10), cleanupExpiredConversions(deps(), 10)]);
    expect(results.reduce((total, result) => total + result.deleted, 0)).toBe(1);
    expect(storage.deletes.sort()).toEqual([row.inputObjectKey, row.outputObjectKey].sort());
    expect((await conversion(row.id)).status).toBe("deleted");
  });

  it("does not confirm a tombstone with a claim that was taken over", async () => {
    const row = await insertConversion();
    const takeover = randomUUID();
    storage.onDelete = async () => {
      await database.update(conversions).set({ retentionToken: takeover }).where(eq(conversions.id, row.id));
    };
    expect(await cleanupExpiredConversions(deps(), 10)).toEqual({ deleted: 0, deferred: 0, failed: 0 });
    expect(await conversion(row.id)).toMatchObject({ status: "deleting", retentionToken: takeover, deletedAt: null });
  });

  it("preserves every object when the database is unavailable", async () => {
    const row = await insertConversion();
    const unavailable = new Proxy(database, {
      get(target, property, receiver) {
        if (property === "transaction") return async () => { throw new Error("connection terminated"); };
        return Reflect.get(target, property, receiver);
      },
    });
    expect(await cleanupExpiredConversions(deps({ database: unavailable }), 10)).toEqual({ deleted: 0, deferred: 0, failed: 1 });
    expect(storage.deletes).toHaveLength(0);
    expect((await conversion(row.id)).status).toBe("completed");
  });

  it("denies new authorizations for deleting and deleted conversions", async () => {
    const row = await insertConversion({ status: "deleting", retentionToken: randomUUID(), retentionLeaseExpiresAt: new Date(NOW.getTime() + LEASE_MS) });
    const read = { database, storage, now: () => NOW };
    await expect(readConversion(ORG, row.id, read)).rejects.toMatchObject({ code: "not_found", status: 404 });
    const history = await listConversionHistory(ORG, {}, { database, cursorSecret: "retention-test-secret-with-thirty-two-characters", now: () => NOW });
    expect(history.items).toHaveLength(0);
    await expect(reprocessConversion({ organizationId: ORG, userId: USER, planId: "FREE" }, row.id, "reprocess-deleting-source", {}, {
      database,
      storage,
      enforceRateLimit: async () => undefined,
      publish: async () => undefined,
      commit: (input) => commitReprocessedConversion(input, database),
      recoverCommit: (input) => recoverReprocessCommit(input, database),
      randomId: randomUUID,
      now: () => NOW,
    })).rejects.toMatchObject({ code: "not_found", status: 404 });
    await database.update(conversions).set({ status: "deleted", deletedAt: NOW, retentionToken: null, retentionLeaseExpiresAt: null }).where(eq(conversions.id, row.id));
    await expect(readConversion(ORG, row.id, read)).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect(storage.deletes).toHaveLength(0);
  });

  it("re-checks expiry while a download is being authorized", async () => {
    const row = await insertConversion({ artifactsExpireAt: new Date(NOW.getTime() + 5_000) });
    let current = NOW;
    storage.onHead = async () => { current = new Date(NOW.getTime() + 6_000); };
    const signDownload = vi.spyOn(storage, "signDownload");
    const view = await readConversion(ORG, row.id, { database, storage, now: () => current });
    expect(view.download).toBeUndefined();
    expect(view.original).toBeUndefined();
    expect(signDownload).not.toHaveBeenCalled();
    signDownload.mockRestore();
  });
});

describe("batch retention", () => {
  it("deletes the archive, keeps the aggregate and only then tombstones the children", async () => {
    const parent = await insertBatch();
    const { completed, failed } = await batchChildren(parent.id);
    await reserve(completed.id, "CONFIRMED");

    const result = await runRetentionCycle(
      { intervalMs: 60_000, batchSize: 10, leaseMs: LEASE_MS, uploadGraceMs: 900_000, workspaceMaxAgeMs: 3_600_000 },
      deps(),
      { workspaceRoot: join(tmpdir(), `uno-retention-missing-${randomUUID()}`) },
    );
    expect(result.batches.deleted).toBe(1);
    expect(result.conversions.deleted).toBe(2);
    expect(storage.deletes[0]).toBe(parent.zipObjectKey);
    expect(storage.objects.size).toBe(0);
    const tombstone = await batch(parent.id);
    expect(tombstone).toMatchObject({ status: "deleted", itemCount: 2, completedCount: 1, failedCount: 1, retentionToken: null });
    expect(tombstone.deletedAt?.toISOString()).toBe(NOW.toISOString());
    expect((await conversion(completed.id)).status).toBe("deleted");
    expect((await conversion(failed.id)).status).toBe("deleted");
    expect((await database.select().from(usageReservations))[0]?.status).toBe("CONFIRMED");

    await expect(readBatch(ORG, parent.id, database)).rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(listBatchItems(ORG, parent.id, {}, database)).rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(signBatchDownload(ORG, parent.id, { database, storage, now: () => NOW })).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect((await listBatches(ORG, {}, database)).items).toHaveLength(0);
    await reconcileBatch(parent.id, database);
    expect((await batch(parent.id)).status).toBe("deleted");
  });

  it("respects a valid archive lease and keeps the children until the aggregate is closed", async () => {
    const archiveToken = randomUUID();
    const parent = await insertBatch({
      status: "processing", phase: "packaging", progress: 99, archiveStatus: "PACKAGING", archiveAttempts: 1,
      archiveToken, archiveLeaseExpiresAt: new Date(NOW.getTime() + 120_000), zipObjectKey: null, zipByteLength: null, completedAt: null,
      completedCount: 0, failedCount: 0,
    });
    const { completed, failed } = await batchChildren(parent.id);
    const attemptZip = `organizations/${ORG}/batch-archives/${parent.id}/${archiveToken}/uno-lote-${parent.id}.zip`;
    storage.objects.set(attemptZip, PDF);

    expect(await cleanupExpiredBatches(deps(), 10)).toEqual({ deleted: 0, deferred: 1, failed: 0 });
    expect(await cleanupExpiredConversions(deps(), 10)).toEqual({ deleted: 0, deferred: 2, failed: 0 });
    expect(storage.deletes).toHaveLength(0);
    expect(await batch(parent.id)).toMatchObject({ status: "processing", archiveStatus: "PACKAGING", archiveToken });
    expect((await conversion(completed.id)).status).toBe("completed");

    const later = new Date(NOW.getTime() + 120_001);
    const laterDeps = deps({ now: () => later });
    expect(await cleanupExpiredBatches(laterDeps, 10)).toEqual({ deleted: 1, deferred: 0, failed: 0 });
    expect(await batch(parent.id)).toMatchObject({
      status: "deleted", phase: "failed", archiveStatus: "FAILED", archiveToken: null, archiveLeaseExpiresAt: null,
      completedCount: 1, failedCount: 1, archiveErrorCode: "archive_expired",
    });
    expect(storage.objects.has(attemptZip)).toBe(false);
    const events = await database.select().from(outboxEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "batch.completed", aggregateId: parent.id, payload: { batchId: parent.id, status: "failed", completedCount: 1, failedCount: 1 } });

    expect(await cleanupExpiredConversions(laterDeps, 10)).toEqual({ deleted: 2, deferred: 0, failed: 0 });
    expect((await conversion(failed.id)).status).toBe("deleted");
    expect(await batch(parent.id)).toMatchObject({ completedCount: 1, failedCount: 1 });
    expect(storage.objects.size).toBe(0);
  });

  it("waits for a child that still holds a valid processing lease before closing the aggregate", async () => {
    const parent = await insertBatch({
      status: "processing", phase: "processing", progress: 50, archiveStatus: "PENDING", zipObjectKey: null, zipByteLength: null,
      completedAt: null, completedCount: 0, failedCount: 0, itemCount: 1,
    });
    await insertConversion({
      batchId: parent.id, status: "processing", outputObjectKey: null, completedAt: null, attempts: 1,
      processingToken: randomUUID(), processingLeaseExpiresAt: new Date(NOW.getTime() + 30_000),
    });
    expect(await cleanupExpiredBatches(deps(), 10)).toEqual({ deleted: 0, deferred: 1, failed: 0 });
    expect((await batch(parent.id)).status).toBe("processing");
    expect(storage.deletes).toHaveLength(0);
  });

  it("keeps a failed archive deletion recoverable", async () => {
    const parent = await insertBatch({ itemCount: 1, completedCount: 1, failedCount: 0 });
    storage.failDeletes.add(parent.zipObjectKey!);
    expect(await cleanupExpiredBatches(deps(), 10)).toEqual({ deleted: 0, deferred: 0, failed: 1 });
    expect(await batch(parent.id)).toMatchObject({ status: "deleting", deletedAt: null });
    storage.failDeletes.clear();
    expect(await cleanupExpiredBatches(deps({ now: () => new Date(NOW.getTime() + LEASE_MS + 1) }), 10)).toEqual({ deleted: 1, deferred: 0, failed: 0 });
    expect((await batch(parent.id)).status).toBe("deleted");
    expect(storage.objects.size).toBe(0);
  });

  it("reports the stored aggregate of a closed batch even after a child tombstone", async () => {
    const future = new Date(NOW.getTime() + 3_600_000);
    const parent = await insertBatch({ artifactsExpireAt: future });
    const { completed } = await batchChildren(parent.id, future);
    await database.update(conversions).set({ artifactsExpireAt: EXPIRED }).where(eq(conversions.id, completed.id));

    expect(await cleanupExpiredConversions(deps(), 10)).toEqual({ deleted: 1, deferred: 0, failed: 0 });
    const detail = await readBatch(ORG, parent.id, database);
    expect(detail.counts).toMatchObject({ total: 2, completed: 1, failed: 1 });
    const items = await listBatchItems(ORG, parent.id, {}, database);
    expect(items.items.map((item) => item.status)).toEqual(["failed"]);
  });

  it("denies archive downloads when expiry passes during authorization", async () => {
    const parent = await insertBatch({ artifactsExpireAt: new Date(NOW.getTime() + 5_000) });
    let current = NOW;
    storage.onHead = async () => { current = new Date(NOW.getTime() + 6_000); };
    const signDownload = vi.spyOn(storage, "signDownload");
    await expect(signBatchDownload(ORG, parent.id, { database, storage, now: () => current })).rejects.toMatchObject({ code: "archive_unavailable", status: 410 });
    await expect(signBatchDownload(ORG, parent.id, { database, storage, now: () => current })).rejects.toMatchObject({ code: "archive_unavailable", status: 410 });
    expect(signDownload).not.toHaveBeenCalled();
    signDownload.mockRestore();
  });
});

describe("orphan candidates", () => {
  const candidateFor = (row: { id: string }, attemptToken: string) => ({
    kind: "conversion-output-attempt" as const,
    organizationId: ORG,
    ownerId: row.id,
    attemptToken,
    key: outputKey(row.id, attemptToken),
    notBefore: EXPIRED,
  });

  it("preserves a candidate whose commit outcome is unknown", async () => {
    const row = await insertConversion({ artifactsExpireAt: new Date(NOW.getTime() + 60_000) });
    const candidate = candidateFor(row, randomUUID());
    storage.objects.set(candidate.key, PDF);
    const inconclusive = new Proxy(database, {
      get(target, property, receiver) {
        if (property === "transaction") return async () => { throw new Error("commit outcome unknown"); };
        return Reflect.get(target, property, receiver);
      },
    });
    expect(await collectOrphanCandidate(candidate, { database: inconclusive, storage, now: () => NOW }))
      .toEqual({ action: "preserved", reason: "inconclusive" });
    expect(storage.objects.has(candidate.key)).toBe(true);
    expect(storage.deletes).toHaveLength(0);
  });

  it("preserves committed, active, unowned, mismatched and not-yet-due candidates", async () => {
    const context = { database, storage, now: () => NOW };
    const committedToken = randomUUID();
    const committedId = randomUUID();
    const committed = await insertConversion({
      id: committedId, outputObjectKey: outputKey(committedId, committedToken), artifactsExpireAt: new Date(NOW.getTime() + 60_000),
    });
    expect(await collectOrphanCandidate(candidateFor(committed, committedToken), context)).toEqual({ action: "preserved", reason: "referenced" });

    const activeToken = randomUUID();
    const active = await insertConversion({
      status: "processing", outputObjectKey: null, completedAt: null, attempts: 1, artifactsExpireAt: new Date(NOW.getTime() + 60_000),
      processingToken: activeToken, processingLeaseExpiresAt: new Date(NOW.getTime() - 1),
    });
    expect(await collectOrphanCandidate(candidateFor(active, activeToken), context)).toEqual({ action: "preserved", reason: "attempt_active" });

    expect(await collectOrphanCandidate(candidateFor({ id: randomUUID() }, randomUUID()), context)).toEqual({ action: "preserved", reason: "owner_unknown" });
    expect(await collectOrphanCandidate({ ...candidateFor(committed, randomUUID()), key: committed.inputObjectKey }, context))
      .toEqual({ action: "preserved", reason: "key_mismatch" });
    expect(await collectOrphanCandidate({ ...candidateFor(committed, "../escape"), key: `organizations/${ORG}/conversion-outputs/${committed.id}/../escape.pdf` }, context))
      .toEqual({ action: "preserved", reason: "key_mismatch" });
    expect(await collectOrphanCandidate({ ...candidateFor(committed, randomUUID()), notBefore: new Date(NOW.getTime() + 1) }, context))
      .toEqual({ action: "preserved", reason: "not_due" });
    expect(storage.deletes).toHaveLength(0);
  });

  it("deletes an attempt object once its owner is locked and no longer references or owns it", async () => {
    const row = await insertConversion({ artifactsExpireAt: new Date(NOW.getTime() + 60_000) });
    const candidate = candidateFor(row, randomUUID());
    storage.objects.set(candidate.key, PDF);
    expect(await collectOrphanCandidate(candidate, { database, storage, now: () => NOW })).toEqual({ action: "deleted" });
    expect(storage.deletes).toEqual([candidate.key]);
    expect(storage.objects.has(row.outputObjectKey!)).toBe(true);
  });
});

describe("expired upload intents", () => {
  const options = { limit: 10, graceMs: 900_000 };

  async function intent(input: Partial<typeof uploadIntents.$inferInsert> = {}) {
    const id = randomUUID();
    const objectKey = `organizations/${ORG}/uploads/${id}.pdf`;
    await database.insert(uploadIntents).values({
      id, organizationId: ORG, createdByUserId: USER, objectKey, contentLength: PDF.length,
      originalFileName: "cliente-sintetico.pdf", expiresAt: new Date(NOW.getTime() - 900_001), ...input,
    });
    storage.objects.set(objectKey, PDF);
    return { id, objectKey };
  }

  it("removes only intents that were never consumed and whose last signed PUT has lapsed", async () => {
    const abandoned = await intent();
    const withinGrace = await intent({ expiresAt: new Date(NOW.getTime() - 60_000) });
    const consumed = await intent({ consumedAt: EXPIRED });
    await insertConversion({ uploadIntentId: consumed.id, artifactsExpireAt: new Date(NOW.getTime() + 60_000) });

    expect(await cleanupExpiredUploadIntents(deps(), options)).toEqual({ deleted: 1, deferred: 0, failed: 0 });
    expect(storage.deletes).toEqual([abandoned.objectKey]);
    expect(storage.objects.has(withinGrace.objectKey)).toBe(true);
    expect(storage.objects.has(consumed.objectKey)).toBe(true);
    const remaining = (await database.select({ id: uploadIntents.id }).from(uploadIntents)).map((row) => row.id).sort();
    expect(remaining).toEqual([withinGrace.id, consumed.id].sort());
    expect(await cleanupExpiredUploadIntents(deps(), options)).toEqual({ deleted: 0, deferred: 0, failed: 0 });
  });

  it("keeps the intent tracked when the staged object cannot be deleted", async () => {
    const abandoned = await intent();
    storage.failDeletes.add(abandoned.objectKey);
    expect(await cleanupExpiredUploadIntents(deps(), options)).toEqual({ deleted: 0, deferred: 0, failed: 1 });
    expect(await database.select().from(uploadIntents)).toHaveLength(1);
    storage.failDeletes.clear();
    expect(await cleanupExpiredUploadIntents(deps(), options)).toEqual({ deleted: 1, deferred: 0, failed: 0 });
    expect(await database.select().from(uploadIntents)).toHaveLength(0);
    expect(storage.objects.size).toBe(0);
  });
});

describe("abandoned engine workspaces", () => {
  it("removes stale private workspaces without following symbolic links", async () => {
    const root = await mkdtemp(join(tmpdir(), "uno-retention-test-"));
    const outside = await mkdtemp(join(tmpdir(), "uno-retention-outside-"));
    try {
      const sentinel = join(outside, "sentinel.txt");
      await writeFile(sentinel, "keep");
      const old = new Date(NOW.getTime() - 2 * 3_600_000);

      const stale = join(root, "uno-engine-AAAAAA");
      await mkdir(stale, { mode: 0o700 });
      await writeFile(join(stale, "page.bin"), "temporary");
      await symlink(outside, join(stale, "linked-directory"));
      await symlink(sentinel, join(stale, "linked-file"));
      await utimes(stale, old, old);

      const fresh = join(root, "uno-engine-BBBBBB");
      await mkdir(fresh, { mode: 0o700 });
      await utimes(fresh, NOW, NOW);

      const linkedWorkspace = join(root, "uno-engine-CCCCCC");
      await symlink(outside, linkedWorkspace);

      const unrelated = join(root, "other-AAAAAA");
      await mkdir(unrelated, { mode: 0o700 });
      await utimes(unrelated, old, old);

      const shared = join(root, "uno-engine-DDDDDD");
      await mkdir(shared, { mode: 0o755 });
      await utimes(shared, old, old);

      expect(await recoverAbandonedEngineWorkspaces({ root, maxAgeMs: 3_600_000, now: NOW })).toBe(1);
      await expect(lstat(stale)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(sentinel, "utf8")).toBe("keep");
      expect((await lstat(fresh)).isDirectory()).toBe(true);
      expect((await lstat(linkedWorkspace)).isSymbolicLink()).toBe(true);
      expect((await lstat(unrelated)).isDirectory()).toBe(true);
      expect((await lstat(shared)).isDirectory()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("skips the root of a live engine pool of this process whatever its age", async () => {
    const root = await mkdtemp(join(tmpdir(), "uno-retention-live-"));
    const pool = new EngineChildPool({ size: 1, tmpRoot: root });
    try {
      const old = new Date(NOW.getTime() - 2 * 3_600_000);
      const live = await pool.prepareRoot();
      expect(liveEngineWorkspaceRoots()).toContain(live);
      await utimes(live, old, old);

      const abandoned = join(root, "uno-engine-ZZZZZZ");
      await mkdir(abandoned, { mode: 0o700 });
      await utimes(abandoned, old, old);

      expect(await recoverAbandonedEngineWorkspaces({ root, maxAgeMs: 3_600_000, now: NOW })).toBe(1);
      expect((await lstat(live)).isDirectory()).toBe(true);
      await expect(lstat(abandoned)).rejects.toMatchObject({ code: "ENOENT" });

      await pool.close();
      expect(liveEngineWorkspaceRoots()).not.toContain(live);
      await expect(lstat(live)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await pool.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an age shorter than the engine deadline allows", async () => {
    await expect(recoverAbandonedEngineWorkspaces({ maxAgeMs: 1_000 })).rejects.toBeInstanceOf(RangeError);
  });
});

describe("retention configuration", () => {
  it("uses safe defaults and accepts bounded overrides", () => {
    expect(readRetentionConfig({})).toEqual({
      intervalMs: 60_000, batchSize: 50, leaseMs: 300_000, uploadGraceMs: 900_000, workspaceMaxAgeMs: 3_600_000,
    });
    expect(readRetentionConfig({ UNO_RETENTION_BATCH_SIZE: "200", UNO_RETENTION_INTERVAL_MS: "5000" })).toMatchObject({ batchSize: 200, intervalMs: 5_000 });
  });

  it.each([
    ["UNO_RETENTION_INTERVAL_MS", "0"],
    ["UNO_RETENTION_INTERVAL_MS", "soon"],
    ["UNO_RETENTION_BATCH_SIZE", "501"],
    ["UNO_RETENTION_BATCH_SIZE", "1.5"],
    ["UNO_RETENTION_LEASE_MS", "-1"],
    ["UNO_RETENTION_LEASE_MS", "9999"],
    ["UNO_RETENTION_UPLOAD_GRACE_MS", "1"],
    ["UNO_ENGINE_TMP_MAX_AGE_MS", "1000"],
  ])("fails explicitly for %s=%s", (variable, value) => {
    expect(() => readRetentionConfig({ [variable]: value })).toThrowError(RetentionConfigError);
  });

  it("refuses to start the worker with an invalid security value", () => {
    vi.stubEnv("UNO_RETENTION_LEASE_MS", "forever");
    try {
      expect(() => startRetentionWorker()).toThrowError(RetentionConfigError);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
