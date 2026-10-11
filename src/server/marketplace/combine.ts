import { randomUUID } from "node:crypto";

import { and, asc, eq, or, sql } from "drizzle-orm";

import { batches, conversions, getDb, outboxEvents, type UnoDatabase } from "@/db";
import { concatPdfs, stampTopLeftNumber } from "@/engine/marketplace/pdf";
import { AppError } from "@/lib/errors";
import { getStorage, type StorageGateway } from "@/server/storage";

const LEASE_MS = 5 * 60_000;
/** Each order output is a single 10×15 label (tens of KB); a lote is read into memory to concat. */
const MAX_SOURCE_BYTES = 150 * 1_024 * 1_024;

type CombineClaim = {
  id: string;
  organizationId: string;
  token: string;
  attempts: number;
  maxAttempts: number;
  numbering: { letter?: string; start: number; showTotal: boolean } | null;
};

type CombineDependencies = {
  database: UnoDatabase;
  storage: StorageGateway;
  randomId(): string;
  now(): Date;
};

function defaults(): CombineDependencies {
  return { database: getDb(), storage: getStorage(), randomId: randomUUID, now: () => new Date() };
}

async function emitCompleted(
  transaction: Pick<UnoDatabase, "select" | "insert">,
  claim: Pick<CombineClaim, "id" | "organizationId">,
  status: "completed" | "failed",
  randomId: () => string,
): Promise<void> {
  const row = await transaction.select({ completed: batches.completedCount, failed: batches.failedCount })
    .from(batches).where(eq(batches.id, claim.id)).limit(1);
  await transaction.insert(outboxEvents).values({
    id: randomId(),
    organizationId: claim.organizationId,
    type: "batch.completed",
    aggregateType: "batch",
    aggregateId: claim.id,
    deduplicationKey: `batch.completed.${claim.id}`,
    payload: { batchId: claim.id, status, completedCount: row[0]?.completed ?? 0, failedCount: row[0]?.failed ?? 0 },
  }).onConflictDoNothing({ target: outboxEvents.deduplicationKey });
}

async function claimCombine(batchId: string, dependencies: CombineDependencies): Promise<CombineClaim | null> {
  return dependencies.database.transaction(async (transaction) => {
    const rows = await transaction.select().from(batches).where(and(
      eq(batches.id, batchId),
      eq(batches.kind, "marketplace"),
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
        status: "failed", phase: "failed", progress: 100, archiveStatus: "FAILED",
        archiveToken: null, archiveLeaseExpiresAt: null,
        archiveErrorCode: "combine_failed", archiveErrorMessage: "Não foi possível montar o PDF do lote.",
        completedAt: now, updatedAt: now,
      }).where(and(eq(batches.id, row.id), eq(batches.archiveStatus, "PACKAGING"), sql`${batches.archiveLeaseExpiresAt} < now()`))
        .returning({ id: batches.id });
      if (failed[0]) await emitCompleted(transaction, row, "failed", dependencies.randomId);
      return null;
    }
    const token = dependencies.randomId();
    const attempts = row.archiveAttempts + 1;
    const updated = await transaction.update(batches).set({
      archiveStatus: "PACKAGING", archiveAttempts: attempts, archiveToken: token,
      archiveLeaseExpiresAt: new Date(dependencies.now().getTime() + LEASE_MS),
      archiveErrorCode: null, archiveErrorMessage: null, updatedAt: dependencies.now(),
    }).where(eq(batches.id, row.id)).returning({ id: batches.id });
    if (!updated[0]) return null;
    return { id: row.id, organizationId: row.organizationId, token, attempts, maxAttempts: row.archiveMaxAttempts, numbering: row.numbering };
  });
}

/** Completed order outputs, in upload order, once every order of the lote has finished. */
async function orderedSources(claim: CombineClaim, dependencies: CombineDependencies) {
  const rows = await dependencies.database.select({
    id: conversions.id,
    index: conversions.batchOrderIndex,
    status: conversions.status,
    outputObjectKey: conversions.outputObjectKey,
    artifactsExpireAt: conversions.artifactsExpireAt,
  }).from(conversions).where(and(eq(conversions.organizationId, claim.organizationId), eq(conversions.batchId, claim.id)))
    .orderBy(asc(conversions.batchOrderIndex), asc(conversions.id));
  if (!rows.length || rows.some((row) => row.status !== "completed" && row.status !== "failed")) {
    throw new AppError("archive_not_ready", "Os pedidos do lote ainda não terminaram.", 409);
  }
  const completed = rows.filter((row) => row.status === "completed");
  if (!completed.length) throw new AppError("archive_empty", "Nenhum pedido pôde ser convertido.", 409);
  if (completed.some((row) => !row.outputObjectKey || !row.artifactsExpireAt)) {
    throw new AppError("archive_incomplete_result", "Um resultado concluído está indisponível.", 500);
  }
  const usable = completed as Array<typeof completed[number] & { outputObjectKey: string; artifactsExpireAt: Date }>;
  const expiresAt = new Date(Math.min(...usable.map((row) => row.artifactsExpireAt.getTime())));
  if (expiresAt <= dependencies.now()) throw new AppError("archive_expired", "Os resultados do lote expiraram.", 410);
  return { usable, expiresAt };
}

async function buildCombinedPdf(
  claim: CombineClaim,
  usable: Array<{ outputObjectKey: string }>,
  dependencies: CombineDependencies,
): Promise<Uint8Array> {
  const total = usable.length;
  const parts: Uint8Array[] = [];
  for (const [position, source] of usable.entries()) {
    let bytes: Uint8Array = await dependencies.storage.read(source.outputObjectKey, MAX_SOURCE_BYTES);
    if (claim.numbering) {
      const value = claim.numbering.start + position;
      const prefix = claim.numbering.letter ?? "";
      const text = claim.numbering.showTotal ? `${prefix}${value}/${total}` : `${prefix}${value}`;
      bytes = await stampTopLeftNumber(bytes, text);
    }
    parts.push(bytes);
  }
  return concatPdfs(parts);
}

async function completeCombine(
  claim: CombineClaim,
  outputKey: string,
  byteLength: number,
  artifactsExpireAt: Date,
  dependencies: CombineDependencies,
): Promise<boolean> {
  return dependencies.database.transaction(async (transaction) => {
    const now = dependencies.now();
    if (artifactsExpireAt <= now) throw new AppError("archive_expired", "Os resultados do lote expiraram.", 410);
    const updated = await transaction.update(batches).set({
      status: "completed", phase: "completed", progress: 100,
      archiveStatus: "READY", archiveToken: null, archiveLeaseExpiresAt: null,
      combinedPdfObjectKey: outputKey, combinedPdfByteLength: byteLength,
      artifactsExpireAt, completedAt: now, updatedAt: now,
    }).where(and(eq(batches.id, claim.id), eq(batches.archiveStatus, "PACKAGING"), eq(batches.archiveToken, claim.token)))
      .returning({ id: batches.id });
    if (!updated[0]) return false;
    await emitCompleted(transaction, claim, "completed", dependencies.randomId);
    return true;
  });
}

async function failCombine(claim: CombineClaim, dependencies: CombineDependencies): Promise<void> {
  const terminal = claim.attempts >= claim.maxAttempts;
  await dependencies.database.transaction(async (transaction) => {
    const updated = await transaction.update(batches).set({
      status: terminal ? "failed" : "processing",
      phase: terminal ? "failed" : "packaging",
      archiveStatus: terminal ? "FAILED" : "PENDING",
      archiveToken: null, archiveLeaseExpiresAt: null,
      archiveErrorCode: terminal ? "combine_failed" : null,
      archiveErrorMessage: terminal ? "Não foi possível montar o PDF do lote." : null,
      completedAt: terminal ? dependencies.now() : null,
      updatedAt: dependencies.now(),
    }).where(and(eq(batches.id, claim.id), eq(batches.archiveStatus, "PACKAGING"), eq(batches.archiveToken, claim.token)))
      .returning({ id: batches.id });
    if (terminal && updated[0]) await emitCompleted(transaction, claim, "failed", dependencies.randomId);
  });
}

/** Assembles a kind='marketplace' lote's order outputs into one combined PDF. */
export async function processMarketplaceCombine(batchId: string, dependencies: CombineDependencies = defaults()): Promise<void> {
  const claim = await claimCombine(batchId, dependencies);
  if (!claim) return;
  const outputKey = `organizations/${claim.organizationId}/batch-archives/${claim.id}/${claim.token}/uno-lote-${claim.id}.pdf`;
  try {
    const { usable, expiresAt } = await orderedSources(claim, dependencies);
    const combined = await buildCombinedPdf(claim, usable, dependencies);
    await dependencies.storage.putBytes(outputKey, Buffer.from(combined), "application/pdf", combined.length);
    try {
      const committed = await completeCombine(claim, outputKey, combined.length, expiresAt, dependencies);
      if (!committed) await dependencies.storage.delete(outputKey).catch(() => undefined);
    } catch (error) {
      await dependencies.storage.delete(outputKey).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    const terminal = error instanceof AppError
      && ["archive_empty", "archive_incomplete_result", "archive_expired"].includes(error.code);
    await failCombine(terminal ? { ...claim, attempts: claim.maxAttempts } : claim, dependencies);
  }
}

export async function processPendingMarketplaceCombines(dependencies: CombineDependencies = defaults()): Promise<number> {
  const rows = await dependencies.database.select({ id: batches.id }).from(batches).where(and(
    eq(batches.kind, "marketplace"),
    eq(batches.status, "processing"),
    eq(batches.phase, "packaging"),
    or(eq(batches.archiveStatus, "PENDING"), and(eq(batches.archiveStatus, "PACKAGING"), sql`${batches.archiveLeaseExpiresAt} < now()`)),
  )).limit(10);
  for (const row of rows) await processMarketplaceCombine(row.id, dependencies);
  return rows.length;
}

export type { CombineDependencies };
