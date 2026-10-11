import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import {
  batches,
  conversions,
  organizations,
  outboxEvents,
  subscriptions,
  templates,
  uploadIntents,
  usagePeriods,
  usageReservations,
  user,
  type UnoDatabase,
} from "@/db";
import { AppError } from "@/lib/errors";
import { createMarketplaceLote, commitMarketplaceLote, type MarketplaceCreationDependencies } from "@/server/marketplace/create";
import { processMarketplaceCombine } from "@/server/marketplace/combine";
import { findUploadIntentForOrganization, readValidatedUpload } from "@/server/uploads";
import type { StorageGateway, StoredObjectHead } from "@/server/storage";
import { syntheticMercadoLivreBatch } from "./fixtures/synthetic-marketplace-pdf";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const USER = "00000000-0000-4000-8000-000000000001";
const ORG = "00000000-0000-4000-8000-000000000101";
const TEMPLATE = "00000000-0000-4000-8000-000000000201";

const pglite = new PGlite();
const database = drizzle(pglite, { schema }) as unknown as UnoDatabase;

class MemoryStorage implements StorageGateway {
  readonly objects = new Map<string, Buffer>();
  async signUpload() { return { url: "https://storage.test/upload", headers: {}, expiresAt: new Date(NOW.getTime() + 300_000) }; }
  async signDownload(key: string, seconds = 300) { return { url: `https://storage.test/${encodeURIComponent(key)}`, expiresAt: new Date(NOW.getTime() + seconds * 1_000) }; }
  async head(key: string): Promise<StoredObjectHead> {
    const bytes = this.objects.get(key);
    if (!bytes) throw new AppError("upload_not_found", "missing", 404);
    return { contentLength: bytes.length, contentType: "application/pdf" };
  }
  async getRange(key: string, max: number) { return (await this.read(key, max)).subarray(0, max); }
  async read(key: string, max: number) {
    const bytes = this.objects.get(key);
    if (!bytes) throw new AppError("upload_not_found", "missing", 404);
    if (bytes.length > max) throw new Error("too_large");
    return Buffer.from(bytes);
  }
  async putBytes(key: string, bytes: Buffer) { this.objects.set(key, Buffer.from(bytes)); }
  async copy(sourceKey: string, targetKey: string) {
    const bytes = this.objects.get(sourceKey);
    if (!bytes) throw new AppError("upload_not_found", "missing", 404);
    this.objects.set(targetKey, Buffer.from(bytes));
  }
  async delete(key: string) { this.objects.delete(key); }
  async openReadStream(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) throw new AppError("upload_not_found", "missing", 404);
    return Readable.from([bytes]);
  }
  async beginMultipartUpload() { return randomUUID(); }
  async uploadPart(_k: string, _u: string, partNumber: number) { return `etag-${partNumber}`; }
  async completeMultipartUpload() { /* unused here */ }
  async abortMultipartUpload() { /* unused here */ }
}

let storage: MemoryStorage;

function deps(): MarketplaceCreationDependencies {
  return {
    storage,
    randomId: randomUUID,
    now: () => NOW,
    loadIntent: (organizationId, intentId) => findUploadIntentForOrganization(organizationId, intentId, database),
    readUpload: (intent, gateway) => readValidatedUpload(intent, { storage: gateway, now: NOW }),
    commit: (input) => commitMarketplaceLote(input, database),
    publish: async () => undefined,
  };
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

/** Seeds a consumable upload intent whose object holds the given marketplace file. */
async function seedUpload(bytes: Uint8Array): Promise<string> {
  const intentId = randomUUID();
  const objectKey = `organizations/${ORG}/uploads/${randomUUID()}.pdf`;
  storage.objects.set(objectKey, Buffer.from(bytes));
  await database.insert(uploadIntents).values({
    id: intentId,
    organizationId: ORG,
    createdByUserId: USER,
    objectKey,
    contentType: "application/pdf",
    contentLength: bytes.length,
    checksumSha256: createHash("sha256").update(bytes).digest("hex"),
    originalFileName: "lote.pdf",
    expiresAt: new Date(NOW.getTime() + 300_000),
    createdAt: NOW,
  });
  return intentId;
}

async function onePagePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([283.4646, 425.1969]);
  return doc.save();
}

beforeAll(async () => {
  await applyMigrations();
  await database.insert(user).values({ id: USER, name: "Synthetic", email: "lote@example.test", emailVerified: true });
  await database.insert(organizations).values({ id: ORG, name: "Lote", slug: "lote", ownerUserId: USER });
  await database.insert(templates).values({
    id: TEMPLATE,
    key: "mercado-livre",
    version: "1.0.0",
    displayName: "Mercado Livre",
    engineVersion: "0.1.0",
    status: "RELEASED",
    releasedAt: NOW,
    definition: { releasedSizes: [{ widthMm: 100, heightMm: 150, automaticReportSha256: "a".repeat(64), physicalProofSha256: "b".repeat(64), approvedAt: NOW.toISOString() }] },
  });
  await database.insert(subscriptions).values({
    organizationId: ORG,
    planId: "STARTER",
    status: "ACTIVE",
    currentPeriodStart: new Date("2026-10-01T00:00:00.000Z"),
    currentPeriodEnd: new Date("2026-11-01T00:00:00.000Z"),
  });
});

beforeEach(async () => {
  storage = new MemoryStorage();
  await database.delete(outboxEvents);
  await database.delete(usageReservations);
  await database.delete(conversions);
  await database.delete(batches);
  await database.delete(usagePeriods);
  await database.delete(uploadIntents);
});

afterAll(async () => { await pglite.close(); });

describe("marketplace lote — create", () => {
  it("splits N orders into one conversion each and reserves N quota units", async () => {
    const intentId = await seedUpload(await syntheticMercadoLivreBatch(3));
    const accepted = await createMarketplaceLote({ organizationId: ORG, userId: USER }, {
      uploadIntentId: intentId, marketplace: "mercado-livre", size: { preset: "100x150" },
    }, deps());

    expect(accepted.itemCount).toBe(3);
    const batchRows = await database.select().from(batches).where(eq(batches.id, accepted.id));
    expect(batchRows[0]).toMatchObject({ kind: "marketplace", marketplace: "mercado-livre", itemCount: 3, phase: "queued" });
    const orderRows = await database.select().from(conversions).where(eq(conversions.batchId, accepted.id));
    expect(orderRows).toHaveLength(3);
    expect(orderRows.map((row) => row.batchOrderIndex).sort()).toEqual([0, 1, 2]);
    const reservations = await database.select().from(usageReservations).where(eq(usageReservations.organizationId, ORG));
    expect(reservations).toHaveLength(3);
    const events = await database.select().from(outboxEvents).where(eq(outboxEvents.type, "conversion.queued"));
    expect(events).toHaveLength(3);
    const intent = await database.select().from(uploadIntents).where(eq(uploadIntents.id, intentId));
    expect(intent[0]!.consumedAt).not.toBeNull();
  });

  it("carries numbering options onto the lote", async () => {
    const intentId = await seedUpload(await syntheticMercadoLivreBatch(2));
    const accepted = await createMarketplaceLote({ organizationId: ORG, userId: USER }, {
      uploadIntentId: intentId, marketplace: "mercado-livre", size: { preset: "100x150" },
      numbering: { start: 1, showTotal: true, letter: "C" },
    }, deps());
    const batchRows = await database.select().from(batches).where(eq(batches.id, accepted.id));
    expect(batchRows[0]!.numbering).toEqual({ start: 1, showTotal: true, letter: "C" });
  });

  it("refuses a second lote from the same consumed upload", async () => {
    const intentId = await seedUpload(await syntheticMercadoLivreBatch(2));
    const input = { uploadIntentId: intentId, marketplace: "mercado-livre" as const, size: { preset: "100x150" as const } };
    await createMarketplaceLote({ organizationId: ORG, userId: USER }, input, deps());
    await expect(createMarketplaceLote({ organizationId: ORG, userId: USER }, input, deps())).rejects.toBeInstanceOf(AppError);
  });

  it("rejects a file whose page count is not whole orders", async () => {
    const base = await PDFDocument.load(await syntheticMercadoLivreBatch(2));
    base.removePage(3);
    const intentId = await seedUpload(await base.save());
    await expect(createMarketplaceLote({ organizationId: ORG, userId: USER }, {
      uploadIntentId: intentId, marketplace: "mercado-livre", size: { preset: "100x150" },
    }, deps())).rejects.toMatchObject({ code: "page_count_mismatch" });
  });
});

describe("marketplace lote — combine", () => {
  async function seedPackagingLote(orderCount: number, numbering: { start: number; showTotal: boolean } | null) {
    const batchId = randomUUID();
    await database.insert(batches).values({
      id: batchId, organizationId: ORG, createdByUserId: USER,
      status: "processing", phase: "packaging", kind: "marketplace", marketplace: "mercado-livre",
      numbering, itemCount: orderCount, completedCount: orderCount, failedCount: 0, progress: 0,
      archiveStatus: "PENDING", artifactsExpireAt: new Date(NOW.getTime() + 86_400_000),
      createdAt: NOW, updatedAt: NOW,
    });
    for (let index = 0; index < orderCount; index += 1) {
      const outputObjectKey = `organizations/${ORG}/conversion-outputs/${randomUUID()}.pdf`;
      storage.objects.set(outputObjectKey, Buffer.from(await onePagePdf()));
      await database.insert(conversions).values({
        id: randomUUID(), organizationId: ORG, createdByUserId: USER, batchId, batchOrderIndex: index,
        templateId: TEMPLATE, templateVersion: "1.0.0", engineVersion: "0.1.0",
        status: "completed", source: "dashboard", progress: 100, currentStage: "completed",
        outputPreset: "100x150", outputWidthMm: "100", outputHeightMm: "150",
        inputObjectKey: `organizations/${ORG}/conversion-inputs/${randomUUID()}.pdf`,
        inputSha256: "a".repeat(64), sourceByteLength: 1_000, outputObjectKey, outputPages: 1,
        artifactsExpireAt: new Date(NOW.getTime() + 86_400_000), queuedAt: NOW, completedAt: NOW, createdAt: NOW, updatedAt: NOW,
      });
    }
    return batchId;
  }

  it("combines the order outputs into one PDF, one page per order", async () => {
    const batchId = await seedPackagingLote(3, { start: 1, showTotal: true });
    await processMarketplaceCombine(batchId, { database, storage, randomId: randomUUID, now: () => NOW });

    const batchRows = await database.select().from(batches).where(eq(batches.id, batchId));
    expect(batchRows[0]).toMatchObject({ status: "completed", phase: "completed", archiveStatus: "READY" });
    const key = batchRows[0]!.combinedPdfObjectKey!;
    expect(key).toMatch(/\.pdf$/);
    const combined = await PDFDocument.load(storage.objects.get(key)!);
    expect(combined.getPageCount()).toBe(3);
    const completedEvent = await database.select().from(outboxEvents).where(and(
      eq(outboxEvents.type, "batch.completed"), eq(outboxEvents.aggregateId, batchId),
    ));
    expect(completedEvent).toHaveLength(1);
  });

  it("does not let the ZIP archiver touch a marketplace lote", async () => {
    const { processPendingBatchArchives } = await import("@/server/batches/archive");
    const batchId = await seedPackagingLote(2, null);
    const picked = await processPendingBatchArchives({
      database, storage, randomId: randomUUID, now: () => NOW, maxBytes: 100 * 1_024 * 1_024, timeoutMs: 60_000,
    });
    expect(picked).toBe(0);
    const batchRows = await database.select().from(batches).where(eq(batches.id, batchId));
    expect(batchRows[0]!.zipObjectKey).toBeNull();
  });
});
