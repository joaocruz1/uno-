import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import { apiKeys, apiRequests, apiRequestUploads, batches, conversions, organizations, outboxEvents, subscriptions, templates, usagePeriods, usageReservations, user, type UnoDatabase } from "@/db";
import { admitPublicBatch, admitPublicConversion, beginPublicRequest, type AdmissionDependencies } from "@/server/api-ingestion/admission";
import { cleanupExpiredApiPreparations } from "@/server/api-ingestion/cleanup";
import { cleanupPreparedUploads, parseApiMultipart, type ParserDependencies } from "@/server/api-ingestion/parser";
import type { ApiActor } from "@/server/api-keys";
import type { StorageGateway, StoredObjectHead } from "@/server/storage";

const USER = "00000000-0000-4000-8000-000000000001";
const ORG = "00000000-0000-4000-8000-000000000101";
const API_KEY = "00000000-0000-4000-8000-000000000201";
const NOW = new Date("2026-10-07T12:00:00.000Z");
const PDF_ONE = Buffer.from("%PDF-1.7\nsynthetic public one\n%%EOF", "ascii");
const PDF_TWO = Buffer.from("%PDF-1.7\nsynthetic public two\n%%EOF", "ascii");
const pglite = new PGlite();
const database = drizzle(pglite, { schema }) as unknown as UnoDatabase;

class MemoryStorage implements StorageGateway {
  readonly objects = new Map<string, Buffer>();
  readonly multipart = new Map<string, Map<number, Buffer>>();
  aborted = 0;
  beginDelayMs = 0;
  async signUpload(): Promise<never> { throw new Error("unused"); }
  async signDownload(): Promise<never> { throw new Error("unused"); }
  async head(key: string): Promise<StoredObjectHead> { return { contentLength: this.objects.get(key)?.length ?? 0 }; }
  async getRange(key: string, max: number) { return (await this.read(key, max)).subarray(0, max); }
  async read(key: string, max: number) {
    const bytes = this.objects.get(key);
    if (!bytes || bytes.length > max) throw new Error("missing");
    return Buffer.from(bytes);
  }
  async putBytes(key: string, bytes: Buffer) { this.objects.set(key, Buffer.from(bytes)); }
  async delete(key: string) { this.objects.delete(key); }
  async openReadStream(key: string) { return Readable.from([await this.read(key, Number.MAX_SAFE_INTEGER)]); }
  async beginMultipartUpload(key: string) {
    if (this.beginDelayMs) await new Promise((resolve) => setTimeout(resolve, this.beginDelayMs));
    const id = randomUUID();
    this.multipart.set(`${key}:${id}`, new Map());
    return id;
  }
  async uploadPart(key: string, uploadId: string, partNumber: number, bytes: Buffer) {
    this.multipart.get(`${key}:${uploadId}`)!.set(partNumber, Buffer.from(bytes));
    return `etag-${partNumber}`;
  }
  async completeMultipartUpload(key: string, uploadId: string, parts: Array<{ partNumber: number }>) {
    const pending = this.multipart.get(`${key}:${uploadId}`)!;
    this.objects.set(key, Buffer.concat(parts.map((part) => pending.get(part.partNumber)!)));
    this.multipart.delete(`${key}:${uploadId}`);
  }
  async abortMultipartUpload(key: string, uploadId: string) {
    this.aborted += 1;
    this.multipart.delete(`${key}:${uploadId}`);
  }
}

async function migrate() {
  const directory = fileURLToPath(new URL("../drizzle", import.meta.url));
  const names = (await readdir(directory)).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
  for (const name of names) {
    const migration = await readFile(`${directory}/${name}`, "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) if (statement.trim()) await pglite.exec(statement);
  }
}

beforeAll(async () => {
  await migrate();
  await database.insert(user).values({ id: USER, name: "API", email: "ingestion@example.test", emailVerified: true });
  await database.insert(organizations).values({ id: ORG, name: "API", slug: "ingestion", ownerUserId: USER });
  await database.insert(subscriptions).values({
    organizationId: ORG, planId: "PRO", status: "ACTIVE",
    currentPeriodStart: new Date("2026-10-01"), currentPeriodEnd: new Date("2026-11-01"),
    apiAddonStatus: "ACTIVE", apiAddonCurrentPeriodEnd: new Date("2026-11-01"),
  });
  await database.insert(apiKeys).values({ id: API_KEY, organizationId: ORG, createdByUserId: USER, name: "Tests", prefix: "uno_test_key", keyHash: "a".repeat(64) });
  await database.insert(templates).values({
    id: "00000000-0000-4000-8000-000000000301", key: "mercado-livre", version: "1.0.0",
    displayName: "Mercado Livre", engineVersion: "0.1.0", status: "RELEASED", releasedAt: NOW,
    definition: { releasedSizes: [{ widthMm: 100, heightMm: 150, automaticReportSha256: "a".repeat(64), physicalProofSha256: "b".repeat(64), approvedAt: NOW.toISOString() }] },
  });
});

beforeEach(async () => {
  await database.delete(usageReservations);
  await database.delete(outboxEvents);
  await database.delete(conversions);
  await database.delete(batches);
  await database.delete(usagePeriods);
  await database.delete(apiRequestUploads);
  await database.delete(apiRequests);
  await database.update(apiKeys).set({ revokedAt: null });
});

afterAll(async () => { vi.unstubAllEnvs(); await pglite.close(); });

const actor: ApiActor = { organizationId: ORG, apiKeyId: API_KEY, planId: "PRO" };

function multipart(files: Array<{ field?: string; name: string; bytes: Buffer; type?: string }>, extraFields: Array<[string, string]> = []) {
  const body = new FormData();
  for (const file of files) body.append(file.field ?? "file", new Blob([Uint8Array.from(file.bytes)], { type: file.type ?? "application/pdf" }), file.name);
  for (const [name, value] of extraFields) body.append(name, value);
  return new Request("http://localhost/api/v1/conversions", { method: "POST", body });
}

async function claim(suffix: string, idempotencyKey: string | null = null) {
  return beginPublicRequest(actor, {
    route: "/api/v1/conversions", method: "POST", idempotencyKey, requestId: `req_${suffix}_12345678`,
  }, { database, randomId: randomUUID, now: () => NOW });
}

function admissionDeps(storage: MemoryStorage): AdmissionDependencies {
  return {
    database,
    storage: undefined as never,
    randomId: randomUUID,
    now: () => NOW,
    publish: async () => undefined,
    cleanup: (organizationId, requestId, attempt) => cleanupPreparedUploads(organizationId, requestId, attempt, { database, storage, now: () => NOW }),
  } as AdmissionDependencies;
}

function deps(storage: MemoryStorage): ParserDependencies {
  return { database, storage, randomId: randomUUID, now: () => NOW };
}

describe("streaming API ingestion", () => {
  it("accepts configuration after the file and preserves ordered batch metadata", async () => {
    const firstClaim = await claim("late");
    const storage = new MemoryStorage();
    const parsed = await parseApiMultipart(multipart([
      { field: "files", name: "one.pdf", bytes: PDF_ONE },
      { field: "files", name: "two.pdf", bytes: PDF_TWO },
    ], [["size", "custom"], ["widthMm", "100"], ["heightMm", "250"]]), {
      organizationId: ORG, apiRequestId: firstClaim.id, attempt: firstClaim.attempt,
      expectedFileField: "files", maxFiles: 2, maxFileBytes: 1_024,
    }, deps(storage));
    expect(parsed.fields).toEqual({ size: "custom", widthMm: "100", heightMm: "250" });
    expect(parsed.files.map((file) => [file.ordinal, file.originalFileName, file.contentLength]))
      .toEqual([[0, "one.pdf", PDF_ONE.length], [1, "two.pdf", PDF_TWO.length]]);
    expect(parsed.files.map((file) => storage.objects.get(file.objectKey)?.toString("ascii")))
      .toEqual([PDF_ONE.toString("ascii"), PDF_TWO.toString("ascii")]);
  });

  it("does not drop a small body while durable tracking and multipart setup are delayed", async () => {
    const current = await claim("slow_setup");
    const storage = new MemoryStorage();
    storage.beginDelayMs = 25;
    const parsed = await parseApiMultipart(multipart([{ name: "small.pdf", bytes: PDF_ONE }]), {
      organizationId: ORG, apiRequestId: current.id, attempt: current.attempt,
      expectedFileField: "file", maxFiles: 1, maxFileBytes: 1_024,
    }, deps(storage));
    expect(parsed.files[0]?.contentLength).toBe(PDF_ONE.length);
    expect(storage.objects.get(parsed.files[0]!.objectKey)).toEqual(PDF_ONE);
  });

  it("rejects extra files, MIME/magic errors, duplicate fields, and byte limits with cleanup", async () => {
    const cases = [
      multipart([{ name: "one.pdf", bytes: PDF_ONE }, { name: "two.pdf", bytes: PDF_TWO }]),
      multipart([{ name: "one.pdf", bytes: PDF_ONE, type: "text/plain" }]),
      multipart([{ name: "one.pdf", bytes: Buffer.from("not a pdf"), type: "application/pdf" }]),
      multipart([{ name: "one.pdf", bytes: PDF_ONE }], [["size", "100x150"], ["size", "a6"]]),
    ];
    for (const [index, request] of cases.entries()) {
      const current = await claim(`invalid_${index}`);
      const storage = new MemoryStorage();
      await expect(parseApiMultipart(request, {
        organizationId: ORG, apiRequestId: current.id, attempt: current.attempt,
        expectedFileField: "file", maxFiles: 1, maxFileBytes: index === 0 ? 1_024 : index === 3 ? PDF_ONE.length - 1 : 1_024,
      }, deps(storage))).rejects.toMatchObject({ code: expect.stringMatching(/invalid|batch|file/) });
      expect(storage.objects.size).toBe(0);
      const rows = await database.select().from(apiRequestUploads).where(eq(apiRequestUploads.apiRequestId, current.id));
      expect(rows.every((row) => row.status === "ABORTED")).toBe(true);
    }
  });

  it("recovers expired multipart preparations without touching committed inputs", async () => {
    const current = await claim("cleanup");
    const storage = new MemoryStorage();
    const prepared = await parseApiMultipart(multipart([{ name: "cleanup.pdf", bytes: PDF_ONE }]), {
      organizationId: ORG, apiRequestId: current.id, attempt: current.attempt,
      expectedFileField: "file", maxFiles: 1, maxFileBytes: 1_024,
    }, deps(storage));
    await database.update(apiRequestUploads).set({ cleanupAfter: new Date(NOW.getTime() - 1) })
      .where(eq(apiRequestUploads.id, prepared.files[0]!.trackingId));
    expect(await cleanupExpiredApiPreparations({ database, storage, now: () => NOW })).toBe(1);
    expect(storage.objects.size).toBe(0);
    const [row] = await database.select().from(apiRequestUploads).where(and(
      eq(apiRequestUploads.apiRequestId, current.id), eq(apiRequestUploads.attempt, current.attempt),
    ));
    expect(row?.status).toBe("ABORTED");
    expect((await database.select().from(apiRequests).where(eq(apiRequests.id, current.id)))[0]?.status).toBe("FAILED");
  });
});

describe("atomic public admission", () => {
  it("replays identical verified bytes without a second resource or quota charge", async () => {
    const storage = new MemoryStorage();
    const idempotencyKey = "same-request-key-0001";
    const firstClaim = await claim("idem_first", idempotencyKey);
    const firstParsed = await parseApiMultipart(multipart([{ name: "same.pdf", bytes: PDF_ONE }]), {
      organizationId: ORG, apiRequestId: firstClaim.id, attempt: firstClaim.attempt,
      expectedFileField: "file", maxFiles: 1, maxFileBytes: 1_024,
    }, deps(storage));
    const first = await admitPublicConversion(actor, firstClaim, firstParsed, admissionDeps(storage));

    const replayClaim = await claim("idem_replay", idempotencyKey);
    expect(replayClaim.replay).toBe(true);
    const replayParsed = await parseApiMultipart(multipart([{ name: "same.pdf", bytes: PDF_ONE }]), {
      organizationId: ORG, apiRequestId: replayClaim.id, attempt: replayClaim.attempt,
      expectedFileField: "file", maxFiles: 1, maxFileBytes: 1_024,
    }, deps(storage));
    await expect(admitPublicConversion(actor, replayClaim, replayParsed, admissionDeps(storage))).resolves.toEqual(first);
    expect(await database.select().from(conversions)).toHaveLength(1);
    expect(await database.select().from(usageReservations)).toHaveLength(1);
    expect(await database.select().from(outboxEvents)).toHaveLength(1);
    expect((await database.select().from(apiRequestUploads).where(eq(apiRequestUploads.attempt, 1)))[0]?.status).toBe("COMMITTED");
    expect((await database.select().from(apiRequestUploads).where(eq(apiRequestUploads.attempt, 2)))[0]?.status).toBe("ABORTED");
  });

  it("rejects a conflicting replay after reading it and removes only its new snapshot", async () => {
    const storage = new MemoryStorage();
    const key = "conflicting-key-00001";
    const firstClaim = await claim("conflict_first", key);
    const firstParsed = await parseApiMultipart(multipart([{ name: "same.pdf", bytes: PDF_ONE }]), {
      organizationId: ORG, apiRequestId: firstClaim.id, attempt: firstClaim.attempt,
      expectedFileField: "file", maxFiles: 1, maxFileBytes: 1_024,
    }, deps(storage));
    await admitPublicConversion(actor, firstClaim, firstParsed, admissionDeps(storage));
    const originalKey = firstParsed.files[0]!.objectKey;

    const conflictingClaim = await claim("conflict_second", key);
    const conflicting = await parseApiMultipart(multipart([{ name: "changed.pdf", bytes: PDF_TWO }]), {
      organizationId: ORG, apiRequestId: conflictingClaim.id, attempt: conflictingClaim.attempt,
      expectedFileField: "file", maxFiles: 1, maxFileBytes: 1_024,
    }, deps(storage));
    await expect(admitPublicConversion(actor, conflictingClaim, conflicting, admissionDeps(storage)))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(storage.objects.has(originalKey)).toBe(true);
    expect(storage.objects.has(conflicting.files[0]!.objectKey)).toBe(false);
  });

  it("revalidates revocation after upload and rolls an over-quota batch back as a unit", async () => {
    const revokedStorage = new MemoryStorage();
    const revokedClaim = await claim("revoked");
    const revokedParsed = await parseApiMultipart(multipart([{ name: "revoked.pdf", bytes: PDF_ONE }]), {
      organizationId: ORG, apiRequestId: revokedClaim.id, attempt: revokedClaim.attempt,
      expectedFileField: "file", maxFiles: 1, maxFileBytes: 1_024,
    }, deps(revokedStorage));
    await database.update(apiKeys).set({ revokedAt: NOW }).where(eq(apiKeys.id, API_KEY));
    await expect(admitPublicConversion(actor, revokedClaim, revokedParsed, admissionDeps(revokedStorage)))
      .rejects.toMatchObject({ code: "unauthorized" });
    expect(await database.select().from(conversions)).toHaveLength(0);
    expect(revokedStorage.objects.size).toBe(0);

    await database.update(apiKeys).set({ revokedAt: null }).where(eq(apiKeys.id, API_KEY));
    vi.stubEnv("UNO_PLAN_PRO_MONTHLY_LIMIT", "1");
    const batchStorage = new MemoryStorage();
    const batchClaim = await beginPublicRequest(actor, {
      route: "/api/v1/batches", method: "POST", idempotencyKey: null, requestId: "req_quota_batch_12345678",
    }, { database, randomId: randomUUID, now: () => NOW });
    const batchParsed = await parseApiMultipart(multipart([
      { field: "files", name: "one.pdf", bytes: PDF_ONE },
      { field: "files", name: "two.pdf", bytes: PDF_TWO },
    ]), {
      organizationId: ORG, apiRequestId: batchClaim.id, attempt: batchClaim.attempt,
      expectedFileField: "files", maxFiles: 2, maxFileBytes: 1_024,
    }, deps(batchStorage));
    await expect(admitPublicBatch(actor, batchClaim, batchParsed, admissionDeps(batchStorage)))
      .rejects.toMatchObject({ code: "quota_exceeded" });
    expect(await database.select().from(batches)).toHaveLength(0);
    expect(await database.select().from(conversions)).toHaveLength(0);
    expect(await database.select().from(usageReservations)).toHaveLength(0);
    expect(await database.select().from(outboxEvents)).toHaveLength(0);
    expect(batchStorage.objects.size).toBe(0);
    vi.unstubAllEnvs();
  });
});
