import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Readable } from "node:stream";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import {
  batches,
  batchUploadItems,
  batchUploadSessions,
  conversions,
  organizations,
  outboxEvents,
  subscriptions,
  templates,
  usagePeriods,
  usageReservations,
  user,
  type UnoDatabase,
} from "@/db";
import { AppError } from "@/lib/errors";
import {
  completeBatchItemUpload,
  cleanupExpiredBatchUploadSessions,
  cleanupExpiredBatchStagingObjects,
  createBatchUploadSession,
  issueBatchItemUpload,
  readBatchUploadSession,
} from "@/server/batch-uploads";
import { processBatchArchive } from "@/server/batches/archive";
import { submitBatch } from "@/server/batches";
import type { StorageGateway, StoredObjectHead } from "@/server/storage";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const USER = "00000000-0000-4000-8000-000000000001";
const ORG = "00000000-0000-4000-8000-000000000101";
const OTHER_ORG = "00000000-0000-4000-8000-000000000102";
const TEMPLATE = "00000000-0000-4000-8000-000000000201";
const SESSION = "00000000-0000-4000-8000-000000000301";
const SESSION_TWO = "00000000-0000-4000-8000-000000000302";
const PDF_ONE = Buffer.from("%PDF-1.7\nsynthetic batch one\n%%EOF", "ascii");
const PDF_TWO = Buffer.from("%PDF-1.7\nsynthetic batch two\n%%EOF", "ascii");

const pglite = new PGlite();
const database = drizzle(pglite, { schema }) as unknown as UnoDatabase;

class MemoryStorage implements StorageGateway {
  readonly objects = new Map<string, Buffer>();
  readonly multipart = new Map<string, Map<number, Buffer>>();
  lastUploadKey?: string;
  onCompleteMultipart?: () => void;

  async signUpload(input: Parameters<StorageGateway["signUpload"]>[0]) {
    this.lastUploadKey = input.key;
    return { url: "https://storage.test/upload", headers: {}, expiresAt: new Date(NOW.getTime() + 300_000) };
  }
  async signDownload(key: string, seconds = 300) {
    return { url: `https://storage.test/${encodeURIComponent(key)}`, expiresAt: new Date(NOW.getTime() + seconds * 1_000) };
  }
  async head(key: string): Promise<StoredObjectHead> {
    const bytes = this.objects.get(key);
    if (!bytes) throw new AppError("upload_not_found", "missing", 404);
    return { contentLength: bytes.length, contentType: key.endsWith(".zip") ? "application/zip" : "application/pdf" };
  }
  async getRange(key: string, max: number) { return (await this.read(key, max)).subarray(0, max); }
  async read(key: string, max: number) {
    const bytes = this.objects.get(key);
    if (!bytes) throw new AppError("upload_not_found", "missing", 404);
    if (bytes.length > max) throw new Error("too_large");
    return Buffer.from(bytes);
  }
  async putBytes(key: string, bytes: Buffer) { this.objects.set(key, Buffer.from(bytes)); }
  async delete(key: string) { this.objects.delete(key); }
  async openReadStream(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) throw new AppError("upload_not_found", "missing", 404);
    return Readable.from([bytes]);
  }
  async beginMultipartUpload(...args: Parameters<StorageGateway["beginMultipartUpload"]>): Promise<string> {
    const [key] = args;
    const id = randomUUID();
    this.multipart.set(`${key}:${id}`, new Map());
    return id;
  }
  async uploadPart(key: string, uploadId: string, partNumber: number, bytes: Buffer) {
    this.multipart.get(`${key}:${uploadId}`)!.set(partNumber, Buffer.from(bytes));
    return `etag-${partNumber}`;
  }
  async completeMultipartUpload(key: string, uploadId: string, parts: Array<{ partNumber: number }>) {
    const stored = this.multipart.get(`${key}:${uploadId}`)!;
    this.objects.set(key, Buffer.concat(parts.map((part) => stored.get(part.partNumber)!)));
    this.multipart.delete(`${key}:${uploadId}`);
    this.onCompleteMultipart?.();
  }
  async abortMultipartUpload(key: string, uploadId: string) { this.multipart.delete(`${key}:${uploadId}`); }
}

async function applyMigrations() {
  const directory = fileURLToPath(new URL("../drizzle", import.meta.url));
  const names = (await readdir(directory)).filter((name) => /^000[0-5]_.*\.sql$/.test(name)).sort();
  for (const name of names) {
    const migration = await readFile(`${directory}/${name}`, "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await pglite.exec(statement);
    }
  }
}

async function seedSession(id: string, itemCount: number) {
  await database.insert(batchUploadSessions).values({
    id,
    organizationId: ORG,
    createdByUserId: USER,
    templateReference: "mercado-livre@1.0.0",
    outputPreset: "custom",
    outputWidthMm: "100",
    outputHeightMm: "250",
    expiresAt: new Date(NOW.getTime() + 86_400_000),
    createdAt: NOW,
    updatedAt: NOW,
  });
  await database.insert(batchUploadItems).values(Array.from({ length: itemCount }, (_, index) => ({
    id: randomUUID(),
    organizationId: ORG,
    sessionId: id,
    clientItemId: randomUUID(),
    originalFileName: `synthetic-${index + 1}.pdf`,
    contentLength: index ? PDF_TWO.length : PDF_ONE.length,
    status: "READY" as const,
    readyObjectKey: `organizations/${ORG}/conversion-inputs/${id}-${index}.pdf`,
    readySha256: (index ? "b" : "a").repeat(64),
    completedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  })));
}

function zipEntries(zip: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  for (let offset = 0; offset <= zip.length - 46; offset += 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) continue;
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    expect(zip.readUInt32LE(localOffset)).toBe(0x04034b50);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = zip.subarray(start, start + compressedSize);
    entries.set(name, method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed));
    offset += 45 + nameLength + extraLength + commentLength;
  }
  return entries;
}

beforeAll(async () => {
  await applyMigrations();
  await database.insert(user).values({ id: USER, name: "Synthetic", email: "batch@example.test", emailVerified: true });
  await database.insert(organizations).values([
    { id: ORG, name: "Batch", slug: "batch", ownerUserId: USER },
    { id: OTHER_ORG, name: "Other", slug: "batch-other", ownerUserId: USER },
  ]);
  await database.insert(templates).values({
    id: TEMPLATE,
    key: "mercado-livre",
    version: "1.0.0",
    displayName: "Mercado Livre",
    engineVersion: "0.1.0",
    status: "RELEASED",
    releasedAt: NOW,
    definition: { releasedSizes: [{ widthMm: 100, heightMm: 250, automaticReportSha256: "a".repeat(64), physicalProofSha256: "b".repeat(64), approvedAt: NOW.toISOString() }] },
  });
  await database.insert(subscriptions).values({ organizationId: ORG, planId: "STARTER", status: "ACTIVE" });
});

beforeEach(async () => {
  await database.delete(outboxEvents);
  await database.delete(usageReservations);
  await database.delete(conversions);
  await database.delete(batches);
  await database.delete(batchUploadItems);
  await database.delete(batchUploadSessions);
  await database.delete(usagePeriods);
});

afterAll(async () => { await pglite.close(); });

describe("batch commit and archive", () => {
  it("cleans abandoned staging and ready snapshots only after expiring the session", async () => {
    const storage = new MemoryStorage();
    const sessionId = randomUUID();
    const itemId = randomUUID();
    const stagingKey = `organizations/${ORG}/batch-staging/${randomUUID()}.pdf`;
    const readyKey = `organizations/${ORG}/conversion-inputs/${randomUUID()}.pdf`;
    storage.objects.set(stagingKey, PDF_ONE);
    storage.objects.set(readyKey, PDF_ONE);
    await database.insert(batchUploadSessions).values({
      id: sessionId, organizationId: ORG, createdByUserId: USER, templateReference: "mercado-livre@1.0.0",
      outputPreset: "custom", outputWidthMm: "100", outputHeightMm: "250", expiresAt: new Date(0), createdAt: NOW, updatedAt: NOW,
    });
    await database.insert(batchUploadItems).values({
      id: itemId, organizationId: ORG, sessionId, clientItemId: randomUUID(), originalFileName: "expired.pdf",
      contentLength: PDF_ONE.length, status: "READY", stagingObjectKey: stagingKey, readyObjectKey: readyKey,
      readySha256: "a".repeat(64), completedAt: NOW, createdAt: NOW, updatedAt: NOW,
    });
    expect(await cleanupExpiredBatchUploadSessions({ database, storage, now: () => NOW })).toBe(1);
    const session = (await database.select().from(batchUploadSessions).where(eq(batchUploadSessions.id, sessionId)))[0]!;
    const item = (await database.select().from(batchUploadItems).where(eq(batchUploadItems.id, itemId)))[0]!;
    expect(session.status).toBe("EXPIRED");
    expect(item).toMatchObject({ status: "FAILED", stagingObjectKey: null, readyObjectKey: null, errorCode: "batch_session_expired" });
    expect(storage.objects.size).toBe(0);
  });

  it("moves a finalized upload into an immutable ready snapshot", async () => {
    const storage = new MemoryStorage();
    const dependencies = { database, storage, randomId: randomUUID, now: () => NOW, rateLimit: async () => undefined };
    const actor = { organizationId: ORG, userId: USER, planId: "STARTER" as const };
    const created = await createBatchUploadSession(actor, {
      items: [{ clientItemId: randomUUID(), originalFileName: "synthetic.pdf", contentLength: PDF_ONE.length }],
      size: { preset: "custom", widthMm: 100, heightMm: 250 },
      template: "mercado-livre@1.0.0",
    }, dependencies);
    const item = created.items[0]!;
    await issueBatchItemUpload(actor, created.id, item.id, dependencies);
    storage.objects.set(storage.lastUploadKey!, PDF_ONE);
    const completed = await completeBatchItemUpload(actor, created.id, item.id, dependencies);
    expect(completed.preparing).toBe(false);
    expect(completed.session.items[0]?.status).toBe("ready");
    const stored = (await database.select().from(batchUploadItems).where(eq(batchUploadItems.id, item.id)))[0]!;
    expect(stored.readyObjectKey).toContain(`/conversion-inputs/`);
    expect(stored.readyObjectKey).not.toBe(stored.stagingObjectKey);
    expect(stored.stagingObjectKey).toBe(`organizations/${ORG}/batch-staging/${item.id}.pdf`);
    expect(storage.objects.has(stored.readyObjectKey!)).toBe(true);
    expect(storage.objects.has(stored.stagingObjectKey!)).toBe(true);
    await database.update(batchUploadItems).set({ stagingExpiresAt: new Date(0) }).where(eq(batchUploadItems.id, item.id));
    await cleanupExpiredBatchStagingObjects({ database, storage, now: () => NOW });
    expect(storage.objects.has(stored.stagingObjectKey!)).toBe(false);
  });

  it("commits every item and reservation once and scopes session reads", async () => {
    await seedSession(SESSION, 2);
    const dependency = { database, storage: new MemoryStorage(), randomId: randomUUID, now: () => NOW, publish: async () => undefined, rateLimit: async () => undefined };
    const actor = { organizationId: ORG, userId: USER, planId: "STARTER" as const };
    const first = await submitBatch(actor, { uploadSessionId: SESSION }, "batch-idempotency-key-0001", dependency);
    const duplicate = await submitBatch(actor, { uploadSessionId: SESSION }, "batch-idempotency-key-0001", dependency);
    expect(duplicate.id).toBe(first.id);
    expect((await database.select({ value: count() }).from(conversions))[0]?.value).toBe(2);
    expect((await database.select({ value: count() }).from(usageReservations))[0]?.value).toBe(2);
    expect((await database.select({ value: count() }).from(outboxEvents).where(eq(outboxEvents.type, "conversion.queued")))[0]?.value).toBe(2);
    const session = await database.select().from(batchUploadSessions).where(eq(batchUploadSessions.id, SESSION));
    expect(session[0]?.status).toBe("ACCEPTED");
    await expect(readBatchUploadSession(OTHER_ORG, SESSION, { database, now: () => NOW })).rejects.toMatchObject({ code: "not_found" });
  });

  it("rolls the whole batch back when quota cannot cover every item", async () => {
    await seedSession(SESSION_TWO, 2);
    await database.insert(usagePeriods).values({
      organizationId: ORG,
      periodStart: new Date("2026-10-01T00:00:00.000Z"),
      periodEnd: new Date("2026-11-01T00:00:00.000Z"),
      limit: 1,
    });
    await expect(submitBatch(
      { organizationId: ORG, userId: USER, planId: "STARTER" },
      { uploadSessionId: SESSION_TWO },
      "batch-idempotency-key-0002",
      { database, storage: new MemoryStorage(), randomId: randomUUID, now: () => NOW, publish: async () => undefined, rateLimit: async () => undefined },
    )).rejects.toMatchObject({ code: "quota_exceeded" });
    expect((await database.select({ value: count() }).from(batches))[0]?.value).toBe(0);
    expect((await database.select({ value: count() }).from(conversions))[0]?.value).toBe(0);
    expect((await database.select({ value: count() }).from(usageReservations))[0]?.value).toBe(0);
    expect((await database.select().from(batchUploadSessions).where(eq(batchUploadSessions.id, SESSION_TWO)))[0]?.status).toBe("OPEN");
  });

  it("recovers an acknowledged batch after the commit response is lost", async () => {
    await seedSession(SESSION, 1);
    let loseAcknowledgement = true;
    const uncertainDatabase = new Proxy(database, {
      get(target, property, receiver) {
        if (property === "transaction") {
          return async (callback: Parameters<UnoDatabase["transaction"]>[0]) => {
            const result = await target.transaction(callback);
            if (loseAcknowledgement) {
              loseAcknowledgement = false;
              throw new Error("synthetic lost commit acknowledgement");
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const accepted = await submitBatch(
      { organizationId: ORG, userId: USER, planId: "STARTER" },
      { uploadSessionId: SESSION },
      "batch-idempotency-key-unknown",
      {
        database: uncertainDatabase,
        storage: new MemoryStorage(),
        randomId: randomUUID,
        now: () => NOW,
        publish: async () => undefined,
        rateLimit: async () => undefined,
      },
    );
    expect((await database.select().from(batches).where(eq(batches.id, accepted.id)))).toHaveLength(1);
    expect((await database.select().from(conversions).where(eq(conversions.batchId, accepted.id)))).toHaveLength(1);
    expect((await database.select().from(batchUploadItems).where(eq(batchUploadItems.sessionId, SESSION)))[0]?.readyObjectKey).toBeTruthy();
  });

  it("streams a ZIP64 with exactly the successful child and publishes once", async () => {
    const storage = new MemoryStorage();
    const batchId = randomUUID();
    const completedId = randomUUID();
    const failedId = randomUUID();
    const expiresAt = new Date(NOW.getTime() + 86_400_000);
    const outputKey = `organizations/${ORG}/outputs/${completedId}.pdf`;
    storage.objects.set(outputKey, PDF_ONE);
    await database.insert(batches).values({
      id: batchId, organizationId: ORG, createdByUserId: USER, status: "processing", phase: "packaging",
      itemCount: 2, completedCount: 1, failedCount: 1, progress: 99, artifactsExpireAt: expiresAt,
      createdAt: NOW, updatedAt: NOW,
    });
    const base = {
      organizationId: ORG, createdByUserId: USER, batchId, templateId: TEMPLATE, templateVersion: "1.0.0", engineVersion: "0.1.0",
      source: "dashboard" as const, outputPreset: "custom", outputWidthMm: "100", outputHeightMm: "250", sourceByteLength: PDF_ONE.length,
      inputSha256: "a".repeat(64), queuedAt: NOW, createdAt: NOW, updatedAt: NOW,
    };
    await database.insert(conversions).values([
      { ...base, id: completedId, status: "completed", progress: 100, currentStage: "completed", inputObjectKey: `inputs/${completedId}.pdf`, outputObjectKey: outputKey, artifactsExpireAt: expiresAt, completedAt: NOW },
      { ...base, id: failedId, status: "failed", progress: 100, currentStage: "failed", inputObjectKey: `inputs/${failedId}.pdf`, errorCode: "invalid_pdf", errorMessage: "Arquivo inválido.", completedAt: NOW },
    ]);
    const dependencies = { database, storage, randomId: randomUUID, now: () => NOW, maxBytes: 1024 * 1024, timeoutMs: 5_000 };
    await processBatchArchive(batchId, dependencies);
    await processBatchArchive(batchId, dependencies);
    const row = (await database.select().from(batches).where(eq(batches.id, batchId)))[0]!;
    expect(row.status).toBe("completed");
    expect(row.archiveStatus).toBe("READY");
    expect(row.zipObjectKey).toBeTruthy();
    const entries = zipEntries(storage.objects.get(row.zipObjectKey!)!);
    expect([...entries.keys()]).toEqual([`${completedId}.pdf`]);
    expect(entries.get(`${completedId}.pdf`)).toEqual(PDF_ONE);
    const events = await database.select().from(outboxEvents).where(and(eq(outboxEvents.type, "batch.completed"), eq(outboxEvents.aggregateId, batchId)));
    expect(events).toHaveLength(1);
  });

  it("fails an exhausted stale archive claim instead of leaving packaging stuck", async () => {
    const batchId = randomUUID();
    await database.insert(batches).values({
      id: batchId,
      organizationId: ORG,
      createdByUserId: USER,
      status: "processing",
      phase: "packaging",
      itemCount: 1,
      completedCount: 1,
      progress: 99,
      archiveStatus: "PACKAGING",
      archiveAttempts: 3,
      archiveMaxAttempts: 3,
      archiveToken: randomUUID(),
      archiveLeaseExpiresAt: new Date(0),
      createdAt: NOW,
      updatedAt: NOW,
    });
    await processBatchArchive(batchId, {
      database,
      storage: new MemoryStorage(),
      randomId: randomUUID,
      now: () => NOW,
      maxBytes: 1024,
      timeoutMs: 1_000,
    });
    const row = (await database.select().from(batches).where(eq(batches.id, batchId)))[0]!;
    expect(row.status).toBe("failed");
    expect(row.archiveStatus).toBe("FAILED");
    expect(row.archiveErrorCode).toBe("archive_failed");
  });

  it("bounds a provider call that ignores abort while creating multipart state", async () => {
    const storage = new MemoryStorage();
    let providerSawAbort = false;
    storage.beginMultipartUpload = async (_key: string, _contentType?: string, signal?: AbortSignal) => new Promise<string>(() => {
      signal?.addEventListener("abort", () => { providerSawAbort = true; }, { once: true });
    });
    const batchId = randomUUID();
    const conversionId = randomUUID();
    const outputKey = `organizations/${ORG}/outputs/${conversionId}.pdf`;
    const expiresAt = new Date(NOW.getTime() + 60_000);
    storage.objects.set(outputKey, PDF_ONE);
    await database.insert(batches).values({
      id: batchId, organizationId: ORG, createdByUserId: USER, status: "processing", phase: "packaging",
      itemCount: 1, completedCount: 1, progress: 99, artifactsExpireAt: expiresAt, createdAt: NOW, updatedAt: NOW,
    });
    await database.insert(conversions).values({
      id: conversionId, organizationId: ORG, createdByUserId: USER, batchId, templateId: TEMPLATE,
      templateVersion: "1.0.0", engineVersion: "0.1.0", status: "completed", source: "dashboard", progress: 100,
      currentStage: "completed", outputPreset: "custom", outputWidthMm: "100", outputHeightMm: "250",
      inputObjectKey: `inputs/${conversionId}.pdf`, inputSha256: "a".repeat(64), outputObjectKey: outputKey,
      sourceByteLength: PDF_ONE.length, artifactsExpireAt: expiresAt, queuedAt: NOW, completedAt: NOW, createdAt: NOW, updatedAt: NOW,
    });
    const startedAt = Date.now();
    await processBatchArchive(batchId, { database, storage, randomId: randomUUID, now: () => NOW, maxBytes: 1024, timeoutMs: 25 });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(providerSawAbort).toBe(true);
    const row = (await database.select().from(batches).where(eq(batches.id, batchId)))[0]!;
    expect(row.archiveStatus).toBe("PENDING");
    expect(row.archiveAttempts).toBe(1);
  });

  it("does not publish an archive when retention expires during provider completion", async () => {
    const storage = new MemoryStorage();
    let clock = new Date(NOW);
    const expiresAt = new Date(NOW.getTime() + 1_000);
    const batchId = randomUUID();
    const conversionId = randomUUID();
    const outputKey = `organizations/${ORG}/outputs/${conversionId}.pdf`;
    storage.objects.set(outputKey, PDF_ONE);
    storage.onCompleteMultipart = () => { clock = new Date(expiresAt.getTime() + 1); };
    await database.insert(batches).values({
      id: batchId, organizationId: ORG, createdByUserId: USER, status: "processing", phase: "packaging",
      itemCount: 1, completedCount: 1, progress: 99, artifactsExpireAt: expiresAt, createdAt: NOW, updatedAt: NOW,
    });
    await database.insert(conversions).values({
      id: conversionId, organizationId: ORG, createdByUserId: USER, batchId, templateId: TEMPLATE,
      templateVersion: "1.0.0", engineVersion: "0.1.0", status: "completed", source: "dashboard",
      progress: 100, currentStage: "completed", outputPreset: "custom", outputWidthMm: "100", outputHeightMm: "250",
      inputObjectKey: `inputs/${conversionId}.pdf`, inputSha256: "a".repeat(64), outputObjectKey: outputKey,
      sourceByteLength: PDF_ONE.length, artifactsExpireAt: expiresAt, queuedAt: NOW, completedAt: NOW, createdAt: NOW, updatedAt: NOW,
    });
    await processBatchArchive(batchId, {
      database,
      storage,
      randomId: randomUUID,
      now: () => clock,
      maxBytes: 1024 * 1024,
      timeoutMs: 5_000,
    });
    const row = (await database.select().from(batches).where(eq(batches.id, batchId)))[0]!;
    expect(row.status).toBe("failed");
    expect(row.archiveErrorCode).toBe("archive_failed");
    expect(row.zipObjectKey).toBeNull();
    expect([...storage.objects.keys()].filter((key) => key.endsWith(".zip"))).toHaveLength(0);
  });
});
