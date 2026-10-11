import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { finished } from "node:stream/promises";

import { ZipArchive } from "archiver";
import { and, eq, or, sql } from "drizzle-orm";

import { batches, conversions, getDb, outboxEvents, type UnoDatabase } from "@/db";
import { AppError } from "@/lib/errors";
import { positiveIntegerEnv } from "@/lib/env";
import { getStorage, type StorageGateway } from "@/server/storage";

const MIN_PART_BYTES = 16 * 1_024 * 1_024;
const MAX_PARTS = 10_000;
const LEASE_MS = 5 * 60_000;
const DEFAULT_MAX_BYTES = 100 * 1_024 * 1_024 * 1_024;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

type ArchiveClaim = {
  id: string;
  organizationId: string;
  token: string;
  attempts: number;
  maxAttempts: number;
};

type ArchiveDependencies = {
  database: UnoDatabase;
  storage: StorageGateway;
  randomId(): string;
  now(): Date;
  maxBytes: number;
  timeoutMs: number;
};

function defaults(): ArchiveDependencies {
  return {
    database: getDb(),
    storage: getStorage(),
    randomId: randomUUID,
    now: () => new Date(),
    maxBytes: positiveIntegerEnv("UNO_BATCH_ARCHIVE_MAX_BYTES", DEFAULT_MAX_BYTES),
    timeoutMs: positiveIntegerEnv("UNO_BATCH_ARCHIVE_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
  };
}

async function claimArchive(batchId: string, dependencies: ArchiveDependencies): Promise<ArchiveClaim | null> {
  return dependencies.database.transaction(async (transaction) => {
    const rows = await transaction.select().from(batches).where(and(
      eq(batches.id, batchId),
      eq(batches.kind, "files"),
      eq(batches.phase, "packaging"),
      eq(batches.status, "processing"),
      or(
        eq(batches.archiveStatus, "PENDING"),
        and(eq(batches.archiveStatus, "PACKAGING"), sql`${batches.archiveLeaseExpiresAt} < now()`),
      ),
    )).limit(1).for("update");
    const row = rows[0];
    if (!row) return null;
    if (row.archiveAttempts >= row.archiveMaxAttempts) {
      const now = dependencies.now();
      const failed = await transaction.update(batches).set({
        status: "failed",
        phase: "failed",
        progress: 100,
        archiveStatus: "FAILED",
        archiveToken: null,
        archiveLeaseExpiresAt: null,
        archiveErrorCode: "archive_failed",
        archiveErrorMessage: "Não foi possível criar o arquivo do lote.",
        completedAt: now,
        updatedAt: now,
      }).where(and(
        eq(batches.id, row.id),
        eq(batches.archiveStatus, "PACKAGING"),
        sql`${batches.archiveLeaseExpiresAt} < now()`,
      )).returning({ id: batches.id });
      if (failed[0]) {
        await transaction.insert(outboxEvents).values({
          id: dependencies.randomId(), organizationId: row.organizationId, type: "batch.completed", aggregateType: "batch", aggregateId: row.id,
          deduplicationKey: `batch.completed.${row.id}`,
          payload: { batchId: row.id, status: "failed", completedCount: row.completedCount, failedCount: row.failedCount },
        }).onConflictDoNothing({ target: outboxEvents.deduplicationKey });
      }
      return null;
    }
    const token = dependencies.randomId();
    const attempts = row.archiveAttempts + 1;
    const updated = await transaction.update(batches).set({
      archiveStatus: "PACKAGING",
      archiveAttempts: attempts,
      archiveToken: token,
      archiveLeaseExpiresAt: new Date(dependencies.now().getTime() + LEASE_MS),
      archiveErrorCode: null,
      archiveErrorMessage: null,
      updatedAt: dependencies.now(),
    }).where(eq(batches.id, row.id)).returning({ id: batches.id });
    if (!updated[0]) return null;
    return { id: row.id, organizationId: row.organizationId, token, attempts, maxAttempts: row.archiveMaxAttempts };
  });
}

async function renewArchiveLease(claim: ArchiveClaim, dependencies: ArchiveDependencies): Promise<boolean> {
  const now = dependencies.now();
  const updated = await dependencies.database.update(batches).set({
    archiveLeaseExpiresAt: new Date(now.getTime() + LEASE_MS),
    updatedAt: now,
  }).where(and(
    eq(batches.id, claim.id),
    eq(batches.status, "processing"),
    eq(batches.archiveStatus, "PACKAGING"),
    eq(batches.archiveToken, claim.token),
  )).returning({ id: batches.id });
  return updated.length === 1;
}

async function validateArchiveSources(claim: ArchiveClaim, dependencies: ArchiveDependencies) {
  const rows = await dependencies.database.select({
    id: conversions.id,
    status: conversions.status,
    outputObjectKey: conversions.outputObjectKey,
    artifactsExpireAt: conversions.artifactsExpireAt,
  }).from(conversions).where(and(eq(conversions.organizationId, claim.organizationId), eq(conversions.batchId, claim.id)));
  if (!rows.length || rows.some((row) => row.status !== "completed" && row.status !== "failed")) {
    throw new AppError("archive_not_ready", "Os itens do lote ainda não terminaram.", 409);
  }
  const completed = rows.filter((row) => row.status === "completed");
  if (!completed.length) throw new AppError("archive_empty", "Nenhum resultado está disponível.", 409);
  if (completed.some((row) => !row.outputObjectKey || !row.artifactsExpireAt)) {
    throw new AppError("archive_incomplete_result", "Um resultado concluído está indisponível.", 500);
  }
  const usable = completed as Array<typeof completed[number] & { outputObjectKey: string; artifactsExpireAt: Date }>;
  const expiresAt = new Date(Math.min(...usable.map((row) => row.artifactsExpireAt.getTime())));
  if (expiresAt <= dependencies.now()) throw new AppError("archive_expired", "Os resultados do lote expiraram.", 410);
  return { usable, expiresAt };
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error("operation_aborted");
  let rejectAborted: ((reason?: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
  const onAbort = () => rejectAborted?.(signal.reason ?? new Error("operation_aborted"));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function zipToMultipart(
  claim: ArchiveClaim,
  outputKey: string,
  results: Array<{ id: string; outputObjectKey: string }>,
  dependencies: ArchiveDependencies,
): Promise<{ byteLength: number; expiresAt: Date }> {
  const controller = new AbortController();
  const activeInputs = new Set<Readable>();
  let uploadId: string | undefined;
  const partBytes = Math.max(MIN_PART_BYTES, Math.ceil(dependencies.maxBytes / MAX_PARTS));
  const parts: Array<{ partNumber: number; etag: string }> = [];
  const pendingChunks: Buffer[] = [];
  let pendingLength = 0;
  let totalBytes = 0;
  let partNumber = 1;
  const archive = new ZipArchive({ forceZip64: true, zlib: { level: 6 } });
  let renewing: Promise<void> = Promise.resolve();
  let claimLost = false;

  const upload = async (bytes: Buffer) => {
    if (claimLost) throw new AppError("archive_claim_lost", "A preparação do arquivo foi interrompida.", 503);
    if (!uploadId) throw new AppError("archive_unavailable", "A preparação do arquivo foi interrompida.", 503);
    if (partNumber > MAX_PARTS) throw new AppError("archive_too_large", "O arquivo do lote excede o limite operacional.", 413);
    const etag = await abortable(
      dependencies.storage.uploadPart(outputKey, uploadId, partNumber, bytes, controller.signal),
      controller.signal,
    );
    parts.push({ partNumber, etag });
    partNumber += 1;
  };
  const takePending = (length: number) => {
    const bytes = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const chunk = pendingChunks[0]!;
      const count = Math.min(chunk.length, length - offset);
      chunk.copy(bytes, offset, 0, count);
      offset += count;
      if (count === chunk.length) pendingChunks.shift();
      else pendingChunks[0] = chunk.subarray(count);
    }
    pendingLength -= length;
    return bytes;
  };
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      void (async () => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += bytes.length;
        if (totalBytes > dependencies.maxBytes) throw new AppError("archive_too_large", "O arquivo do lote excede o limite operacional.", 413);
        pendingChunks.push(bytes);
        pendingLength += bytes.length;
        while (pendingLength >= partBytes) await upload(takePending(partBytes));
      })().then(() => callback(), callback);
    },
    final(callback) {
      void (async () => {
        if (pendingLength > 0) await upload(takePending(pendingLength));
      })().then(() => callback(), callback);
    },
  });
  archive.pipe(sink);
  const sinkFinished = finished(sink);
  void sinkFinished.catch(() => undefined);
  const archiveError = new Promise<never>((_resolve, reject) => archive.once("error", reject));
  const timer = setTimeout(() => {
    const error = new Error("archive_timeout");
    controller.abort(error);
    for (const input of activeInputs) input.destroy(error);
    archive.abort();
    sink.destroy(error);
  }, dependencies.timeoutMs);
  timer.unref();
  const leaseTimer = setInterval(() => {
    renewing = renewing.then(async () => {
      if (claimLost) return;
      try {
        claimLost = !(await renewArchiveLease(claim, dependencies));
      } catch {
        claimLost = true;
      }
      if (claimLost) {
        const error = new AppError("archive_claim_lost", "A preparação do arquivo foi interrompida.", 503);
        controller.abort(error);
        for (const input of activeInputs) input.destroy(error);
        archive.abort();
        sink.destroy(error);
      }
    });
  }, 60_000);
  leaseTimer.unref();
  try {
    uploadId = await abortable(
      dependencies.storage.beginMultipartUpload(outputKey, "application/zip", controller.signal),
      controller.signal,
    );
    for (const result of results) {
      const lazy = Readable.from((async function* () {
        const input = await abortable(
          dependencies.storage.openReadStream(result.outputObjectKey, controller.signal),
          controller.signal,
        );
        activeInputs.add(input);
        try {
          for await (const chunk of input) yield chunk;
        } finally {
          activeInputs.delete(input);
          input.destroy();
        }
      })());
      archive.append(lazy, { name: `${result.id}.pdf` });
    }
    await Promise.race([Promise.all([archive.finalize(), sinkFinished]), archiveError]);
    await renewing;
    if (claimLost) throw new AppError("archive_claim_lost", "A preparação do arquivo foi interrompida.", 503);
    if (!parts.length) throw new Error("archive_empty");
    const { expiresAt } = await validateArchiveSources(claim, dependencies);
    if (!(await renewArchiveLease(claim, dependencies))) {
      throw new AppError("archive_claim_lost", "A preparação do arquivo foi interrompida.", 503);
    }
    await abortable(
      dependencies.storage.completeMultipartUpload(outputKey, uploadId, parts, controller.signal),
      controller.signal,
    );
    return { byteLength: totalBytes, expiresAt };
  } catch (error) {
    controller.abort(error);
    for (const input of activeInputs) input.destroy(error instanceof Error ? error : undefined);
    archive.abort();
    sink.destroy();
    if (uploadId) {
      const abortController = new AbortController();
      const abortTimer = setTimeout(() => abortController.abort(), 10_000);
      abortTimer.unref();
      const aborting = dependencies.storage.abortMultipartUpload(outputKey, uploadId, abortController.signal).catch(() => undefined);
      let deadlineTimer: NodeJS.Timeout | undefined;
      const deadline = new Promise<void>((resolve) => {
        deadlineTimer = setTimeout(resolve, 10_000);
        deadlineTimer.unref();
      });
      await Promise.race([aborting, deadline]);
      clearTimeout(abortTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
    }
    throw error;
  } finally {
    controller.abort();
    for (const input of activeInputs) input.destroy();
    clearTimeout(timer);
    clearInterval(leaseTimer);
    await renewing;
  }
}

async function completeArchive(
  claim: ArchiveClaim,
  outputKey: string,
  byteLength: number,
  artifactsExpireAt: Date,
  dependencies: ArchiveDependencies,
): Promise<boolean> {
  return dependencies.database.transaction(async (transaction) => {
    const now = dependencies.now();
    if (artifactsExpireAt <= now) throw new AppError("archive_expired", "Os resultados do lote expiraram.", 410);
    const updated = await transaction.update(batches).set({
      status: "completed",
      phase: "completed",
      progress: 100,
      archiveStatus: "READY",
      archiveToken: null,
      archiveLeaseExpiresAt: null,
      zipObjectKey: outputKey,
      zipByteLength: byteLength,
      artifactsExpireAt,
      completedAt: now,
      updatedAt: now,
    }).where(and(
      eq(batches.id, claim.id),
      eq(batches.archiveStatus, "PACKAGING"),
      eq(batches.archiveToken, claim.token),
    )).returning({ id: batches.id });
    if (!updated[0]) return false;
    const row = await transaction.select({ organizationId: batches.organizationId, completed: batches.completedCount, failed: batches.failedCount })
      .from(batches).where(eq(batches.id, claim.id)).limit(1);
    await transaction.insert(outboxEvents).values({
      id: dependencies.randomId(),
      organizationId: claim.organizationId,
      type: "batch.completed",
      aggregateType: "batch",
      aggregateId: claim.id,
      deduplicationKey: `batch.completed.${claim.id}`,
      payload: { batchId: claim.id, status: "completed", completedCount: row[0]?.completed ?? 0, failedCount: row[0]?.failed ?? 0 },
    }).onConflictDoNothing({ target: outboxEvents.deduplicationKey });
    return true;
  });
}

async function failArchive(claim: ArchiveClaim, dependencies: ArchiveDependencies): Promise<void> {
  const terminal = claim.attempts >= claim.maxAttempts;
  await dependencies.database.transaction(async (transaction) => {
    const updated = await transaction.update(batches).set({
      status: terminal ? "failed" : "processing",
      phase: terminal ? "failed" : "packaging",
      archiveStatus: terminal ? "FAILED" : "PENDING",
      archiveToken: null,
      archiveLeaseExpiresAt: null,
      archiveErrorCode: terminal ? "archive_failed" : null,
      archiveErrorMessage: terminal ? "Não foi possível criar o arquivo do lote." : null,
      completedAt: terminal ? dependencies.now() : null,
      updatedAt: dependencies.now(),
    }).where(and(eq(batches.id, claim.id), eq(batches.archiveStatus, "PACKAGING"), eq(batches.archiveToken, claim.token)))
      .returning({ id: batches.id });
    if (!terminal || !updated[0]) return;
    const row = await transaction.select({ completed: batches.completedCount, failed: batches.failedCount }).from(batches).where(eq(batches.id, claim.id)).limit(1);
    await transaction.insert(outboxEvents).values({
      id: dependencies.randomId(), organizationId: claim.organizationId, type: "batch.completed", aggregateType: "batch", aggregateId: claim.id,
      deduplicationKey: `batch.completed.${claim.id}`,
      payload: { batchId: claim.id, status: "failed", completedCount: row[0]?.completed ?? 0, failedCount: row[0]?.failed ?? 0 },
    }).onConflictDoNothing({ target: outboxEvents.deduplicationKey });
  });
}

export async function processBatchArchive(batchId: string, dependencies: ArchiveDependencies = defaults()): Promise<void> {
  const claim = await claimArchive(batchId, dependencies);
  if (!claim) return;
  const outputKey = `organizations/${claim.organizationId}/batch-archives/${claim.id}/${claim.token}/uno-lote-${claim.id}.zip`;
  try {
    const { usable } = await validateArchiveSources(claim, dependencies);
    const { byteLength, expiresAt } = await zipToMultipart(
      claim,
      outputKey,
      usable.map((row) => ({ id: row.id, outputObjectKey: row.outputObjectKey })),
      dependencies,
    );
    try {
      if (expiresAt <= dependencies.now()) {
        throw new AppError("archive_expired", "Os resultados do lote expiraram.", 410);
      }
      const committed = await completeArchive(claim, outputKey, byteLength, expiresAt, dependencies);
      if (!committed) await dependencies.storage.delete(outputKey).catch(() => undefined);
    } catch (error) {
      try {
        const rows = await dependencies.database.transaction(async (transaction) => transaction.select({
          status: batches.status,
          key: batches.zipObjectKey,
        }).from(batches).where(and(eq(batches.organizationId, claim.organizationId), eq(batches.id, claim.id))).limit(1).for("update"));
        if (rows[0]?.status !== "completed" || rows[0].key !== outputKey) await dependencies.storage.delete(outputKey).catch(() => undefined);
      } catch {
        // A lost commit acknowledgement can hide a published archive. Preserve it.
      }
      throw error;
    }
  } catch (error) {
    const terminal = error instanceof AppError && [
      "archive_too_large",
      "archive_empty",
      "archive_incomplete_result",
      "archive_expired",
    ].includes(error.code);
    await failArchive(terminal ? { ...claim, attempts: claim.maxAttempts } : claim, dependencies);
  }
}

export async function processPendingBatchArchives(dependencies: ArchiveDependencies = defaults()): Promise<number> {
  const rows = await dependencies.database.select({ id: batches.id }).from(batches).where(and(
    eq(batches.kind, "files"),
    eq(batches.status, "processing"),
    eq(batches.phase, "packaging"),
    or(eq(batches.archiveStatus, "PENDING"), and(eq(batches.archiveStatus, "PACKAGING"), sql`${batches.archiveLeaseExpiresAt} < now()`)),
  )).limit(10);
  for (const row of rows) await processBatchArchive(row.id, dependencies);
  return rows.length;
}

export type { ArchiveDependencies, ArchiveClaim };
