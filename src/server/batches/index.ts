import { createHash, randomUUID } from "node:crypto";

import { and, asc, desc, eq, lt, or, sql } from "drizzle-orm";
import { z } from "zod";

import {
  batches,
  batchUploadItems,
  batchUploadSessions,
  conversions,
  getDb,
  outboxEvents,
  subscriptions,
  type UnoDatabase,
} from "@/db";
import { QuotaExceededError, reserveUsage } from "@/db/usage";
import {
  acceptedBatchSchema,
  batchDetailSchema,
  batchItemsPageSchema,
  batchListSchema,
  type AcceptedBatch,
  type BatchDetail,
  type BatchItemsPage,
  type BatchList,
} from "@/lib/batch-model";
import { AppError } from "@/lib/errors";
import { outputSizeSchema, sizeDimensions, type OutputSize } from "@/lib/label-size";
import { getPlanCatalog, type PlanId } from "@/lib/plans";
import type { Actor } from "@/server/auth/actor";
import { assertUsageAvailable, effectivePlanFromSubscription, lockCurrentUsagePeriod, subscriptionEntitlementColumns } from "@/server/billing/entitlements";
import { publishPendingConversionJobs } from "@/server/queue/outbox";
import { enforceRateLimit } from "@/server/rate-limit";
import { getStorage, type StorageGateway } from "@/server/storage";
import { assertTemplateEligible, findTemplate, seedInitialDraftTemplate } from "@/server/conversions/templates";

export const submitBatchSchema = z.object({ uploadSessionId: z.uuid() }).strict();
const idempotencyKeySchema = z.string().min(16).max(128).regex(/^[\x21-\x7e]+$/);

type BatchDependencies = {
  database: UnoDatabase;
  storage: StorageGateway;
  randomId(): string;
  now(): Date;
  publish(eventId: string): Promise<void>;
  rateLimit(actor: Pick<Actor, "organizationId" | "planId">): Promise<void>;
};

function defaults(): BatchDependencies {
  return {
    database: getDb(),
    storage: getStorage(),
    randomId: randomUUID,
    now: () => new Date(),
    publish: async (eventId) => { await publishPendingConversionJobs({ eventId, limit: 1 }); },
    rateLimit: async (actor) => enforceRateLimit({
      namespace: "dashboard-batch-submit",
      identifier: actor.organizationId,
      limit: getPlanCatalog()[actor.planId].rateLimit || 30,
    }),
  };
}

function retentionDate(now: Date, planId: PlanId) {
  return new Date(now.getTime() + getPlanCatalog()[planId].retentionDays * 86_400_000);
}

function sessionSize(session: typeof batchUploadSessions.$inferSelect): OutputSize {
  return outputSizeSchema.parse(session.outputPreset === "custom" ? {
    preset: "custom",
    widthMm: Number(session.outputWidthMm),
    heightMm: Number(session.outputHeightMm),
  } : { preset: session.outputPreset });
}

async function existingBatch(
  organizationId: string,
  idempotencyKey: string,
  requestHash: string,
  database: Pick<UnoDatabase, "select">,
): Promise<AcceptedBatch | null> {
  const rows = await database.select({
    id: batches.id,
    status: batches.status,
    progress: batches.progress,
    itemCount: batches.itemCount,
    requestHash: batches.requestHash,
    createdAt: batches.createdAt,
  }).from(batches).where(and(eq(batches.organizationId, organizationId), eq(batches.idempotencyKey, idempotencyKey))).limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.requestHash !== requestHash) throw new AppError("idempotency_conflict", "A chave de idempotência já foi usada com outros parâmetros.", 409);
  return acceptedBatchSchema.parse({
    id: row.id,
    status: "queued",
    progress: 0,
    itemCount: row.itemCount,
    createdAt: row.createdAt.toISOString(),
  });
}

type BatchCommitInput = {
  actor: Pick<Actor, "organizationId" | "userId">;
  uploadSessionId: string;
  idempotencyKey: string;
  requestHash: string;
  batchId: string;
  now(): Date;
  randomId(): string;
};

type BatchCommitResult = { accepted: AcceptedBatch; outboxIds: string[] };

export async function commitBatch(input: BatchCommitInput, database: UnoDatabase = getDb()): Promise<BatchCommitResult> {
  return database.transaction(async (transaction) => {
    const sessions = await transaction.select().from(batchUploadSessions).where(and(
      eq(batchUploadSessions.organizationId, input.actor.organizationId),
      eq(batchUploadSessions.id, input.uploadSessionId),
    )).limit(1).for("update");
    const session = sessions[0];
    if (!session) throw new AppError("not_found", "Sessão de lote não encontrada.", 404);
    const duplicate = await existingBatch(input.actor.organizationId, input.idempotencyKey, input.requestHash, transaction);
    if (duplicate) {
      const events = await transaction.select({ id: outboxEvents.id }).from(outboxEvents).where(and(
        eq(outboxEvents.organizationId, input.actor.organizationId),
        eq(outboxEvents.type, "conversion.queued"),
        sql`${outboxEvents.aggregateId} in (select id from conversions where batch_id = ${duplicate.id})`,
      ));
      return { accepted: duplicate, outboxIds: events.map((event) => event.id) };
    }
    if (session.status !== "OPEN") throw new AppError("batch_session_consumed", "A sessão de lote já foi utilizada.", 409);
    const items = await transaction.select().from(batchUploadItems).where(and(
      eq(batchUploadItems.organizationId, input.actor.organizationId),
      eq(batchUploadItems.sessionId, session.id),
    )).orderBy(asc(batchUploadItems.createdAt), asc(batchUploadItems.id)).for("update");
    if (!items.length || items.some((item) => item.status !== "READY" || !item.readyObjectKey || !item.readySha256)) {
      throw new AppError("batch_not_ready", "Finalize todos os arquivos antes de enviar o lote.", 409);
    }

    if (process.env.NODE_ENV !== "production" && process.env.UNO_ALLOW_DRAFT_TEMPLATES === "true") {
      await seedInitialDraftTemplate(transaction);
    }
    const template = await findTemplate(session.templateReference, transaction);
    const size = sessionSize(session);
    assertTemplateEligible(template, size);
    const subscriptionRows = await transaction.select({
      ...subscriptionEntitlementColumns,
    }).from(subscriptions).where(eq(subscriptions.organizationId, input.actor.organizationId)).limit(1).for("update");
    const subscription = subscriptionRows[0];
    const decisionNow = input.now();
    if (session.expiresAt <= decisionNow) throw new AppError("batch_session_expired", "A sessão de lote expirou.", 410);
    const entitlement = effectivePlanFromSubscription(subscription, decisionNow);
    const planId = entitlement.planId;
    if (items.length > entitlement.plan.batchLimit) throw new AppError("batch_limit_exceeded", "O lote excede o limite do plano atual.", 413);
    const maxFileBytes = entitlement.plan.maxFileMB * 1_024 * 1_024;
    if (items.some((item) => item.contentLength > maxFileBytes)) {
      throw new AppError("file_too_large", "Um arquivo excede o limite do plano atual.", 413);
    }
    const usagePeriod = await lockCurrentUsagePeriod(input.actor.organizationId, entitlement, decisionNow, transaction);
    assertUsageAvailable(usagePeriod, entitlement.plan.monthlyLimit, items.length);
    const artifactsExpireAt = retentionDate(decisionNow, planId);
    await transaction.insert(batches).values({
      id: input.batchId,
      organizationId: input.actor.organizationId,
      createdByUserId: input.actor.userId,
      uploadSessionId: session.id,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      status: "queued",
      phase: "queued",
      itemCount: items.length,
      progress: 0,
      artifactsExpireAt,
      createdAt: decisionNow,
      updatedAt: decisionNow,
    });
    const dimensions = sizeDimensions(size);
    const outboxIds: string[] = [];
    try {
      for (const item of items) {
        const conversionId = input.randomId();
        const reservationId = input.randomId();
        const outboxId = input.randomId();
        await transaction.insert(conversions).values({
          id: conversionId,
          organizationId: input.actor.organizationId,
          createdByUserId: input.actor.userId,
          batchId: input.batchId,
          templateId: template.id,
          templateVersion: template.version,
          engineVersion: template.engineVersion,
          status: "queued",
          source: "dashboard",
          originalFileName: item.originalFileName,
          progress: 0,
          currentStage: "queued",
          outputPreset: size.preset,
          outputWidthMm: String(dimensions.widthMm),
          outputHeightMm: String(dimensions.heightMm),
          inputObjectKey: item.readyObjectKey!,
          inputSha256: item.readySha256!,
          sourceByteLength: item.contentLength,
          artifactsExpireAt,
          queuedAt: decisionNow,
          createdAt: decisionNow,
          updatedAt: decisionNow,
        });
        await reserveUsage({
          reservationId,
          organizationId: input.actor.organizationId,
          usagePeriodId: usagePeriod.id,
          conversionId,
        }, transaction);
        await transaction.insert(outboxEvents).values({
          id: outboxId,
          organizationId: input.actor.organizationId,
          type: "conversion.queued",
          aggregateType: "conversion",
          aggregateId: conversionId,
          deduplicationKey: `conversion.queued.${conversionId}`,
          payload: { conversionId },
        });
        outboxIds.push(outboxId);
      }
    } catch (error) {
      if (error instanceof QuotaExceededError) throw new AppError("quota_exceeded", "A organização atingiu a cota mensal.", 403);
      throw error;
    }
    await transaction.update(batchUploadSessions).set({
      status: "ACCEPTED",
      acceptedBatchId: input.batchId,
      updatedAt: decisionNow,
    }).where(and(eq(batchUploadSessions.id, session.id), eq(batchUploadSessions.status, "OPEN")));
    return {
      accepted: acceptedBatchSchema.parse({
        id: input.batchId, status: "queued", progress: 0, itemCount: items.length, createdAt: decisionNow.toISOString(),
      }),
      outboxIds,
    };
  });
}

async function recoverBatchCommit(input: BatchCommitInput, database: UnoDatabase): Promise<BatchCommitResult | null> {
  return database.transaction(async (transaction) => {
    await transaction.select({ id: batchUploadSessions.id }).from(batchUploadSessions).where(and(
      eq(batchUploadSessions.organizationId, input.actor.organizationId),
      eq(batchUploadSessions.id, input.uploadSessionId),
    )).limit(1).for("update");
    const duplicate = await existingBatch(input.actor.organizationId, input.idempotencyKey, input.requestHash, transaction);
    if (!duplicate) return null;
    const events = await transaction.select({ id: outboxEvents.id }).from(outboxEvents).where(and(
      eq(outboxEvents.organizationId, input.actor.organizationId),
      eq(outboxEvents.type, "conversion.queued"),
      sql`${outboxEvents.aggregateId} in (select id from conversions where batch_id = ${duplicate.id})`,
    ));
    if (events.length !== duplicate.itemCount) throw new Error("batch_commit_recovery_inconsistent");
    return { accepted: duplicate, outboxIds: events.map((event) => event.id) };
  });
}

export async function submitBatch(
  actor: Pick<Actor, "organizationId" | "userId" | "planId">,
  rawInput: unknown,
  idempotencyKey: string | null,
  dependencies: BatchDependencies = defaults(),
): Promise<AcceptedBatch> {
  const request = submitBatchSchema.parse(rawInput);
  const key = idempotencyKeySchema.safeParse(idempotencyKey);
  if (!key.success) throw new AppError("invalid_idempotency_key", "Idempotency-Key inválida.", 400);
  await dependencies.rateLimit(actor);
  const requestHash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
  const duplicate = await existingBatch(actor.organizationId, key.data, requestHash, dependencies.database);
  if (duplicate) return duplicate;
  const input: BatchCommitInput = {
    actor,
    uploadSessionId: request.uploadSessionId,
    idempotencyKey: key.data,
    requestHash,
    batchId: dependencies.randomId(),
    now: dependencies.now,
    randomId: dependencies.randomId,
  };
  let committed: BatchCommitResult;
  try {
    committed = await commitBatch(input, dependencies.database);
  } catch (error) {
    try {
      const recovered = await recoverBatchCommit(input, dependencies.database);
      if (!recovered) throw error;
      committed = recovered;
    } catch (recoveryError) {
      if (recoveryError instanceof AppError) throw recoveryError;
      throw error;
    }
  }
  // Keep the request bounded for large batches; the durable outbox pump publishes the remainder.
  await Promise.allSettled(committed.outboxIds.slice(0, 10).map((eventId) => dependencies.publish(eventId)));
  return committed.accepted;
}

type Aggregate = { total: number; queued: number; processing: number; completed: number; failed: number; progress: number };

async function aggregateBatch(batchId: string, database: UnoDatabase): Promise<Aggregate> {
  const rows = await database.select({
    total: sql<number>`count(*)::integer`,
    queued: sql<number>`count(*) filter (where ${conversions.status} = 'queued')::integer`,
    processing: sql<number>`count(*) filter (where ${conversions.status} = 'processing')::integer`,
    completed: sql<number>`count(*) filter (where ${conversions.status} = 'completed')::integer`,
    failed: sql<number>`count(*) filter (where ${conversions.status} = 'failed')::integer`,
    progress: sql<number>`coalesce(avg(${conversions.progress}), 0)::integer`,
  }).from(conversions).where(eq(conversions.batchId, batchId));
  return rows[0] ?? { total: 0, queued: 0, processing: 0, completed: 0, failed: 0, progress: 0 };
}

export async function reconcileBatch(batchId: string, database: UnoDatabase = getDb()): Promise<void> {
  await database.transaction(async (transaction) => {
    const rows = await transaction.select().from(batches).where(eq(batches.id, batchId)).limit(1).for("update");
    const batch = rows[0];
    if (!batch || (batch.status !== "queued" && batch.status !== "processing")) return;
    const counts = await aggregateBatch(batch.id, transaction);
    const allTerminal = counts.total > 0 && counts.completed + counts.failed === counts.total;
    const now = new Date();
    if (!allTerminal) {
      await transaction.update(batches).set({
        status: counts.processing > 0 || counts.completed > 0 || counts.failed > 0 ? "processing" : "queued",
        phase: counts.processing > 0 || counts.completed > 0 || counts.failed > 0 ? "processing" : "queued",
        completedCount: counts.completed,
        failedCount: counts.failed,
        progress: Math.min(98, counts.progress),
        updatedAt: now,
      }).where(eq(batches.id, batch.id));
      return;
    }
    if (counts.completed === 0) {
      await transaction.update(batches).set({
        status: "failed", phase: "failed", progress: 100,
        completedCount: 0, failedCount: counts.failed,
        archiveStatus: "FAILED", archiveErrorCode: "no_outputs", archiveErrorMessage: "Nenhum arquivo foi convertido com sucesso.",
        completedAt: now, updatedAt: now,
      }).where(eq(batches.id, batch.id));
      await transaction.insert(outboxEvents).values({
        id: randomUUID(), organizationId: batch.organizationId, type: "batch.completed", aggregateType: "batch", aggregateId: batch.id,
        deduplicationKey: `batch.completed.${batch.id}`, payload: { batchId: batch.id, status: "failed", completedCount: 0, failedCount: counts.failed },
      }).onConflictDoNothing({ target: outboxEvents.deduplicationKey });
    } else {
      await transaction.update(batches).set({
        status: "processing", phase: "packaging", progress: 99,
        completedCount: counts.completed, failedCount: counts.failed, updatedAt: now,
      }).where(eq(batches.id, batch.id));
    }
  });
}

const notRetired = sql`${batches.status} not in ('deleting','deleted')`;

/** A closed batch reports the aggregate stored at completion, so later child tombstones cannot change it. */
function closedAggregate(row: typeof batches.$inferSelect): Aggregate | null {
  if (row.status !== "completed" && row.status !== "failed") return null;
  return { total: row.itemCount, queued: 0, processing: 0, completed: row.completedCount, failed: row.failedCount, progress: 100 };
}

function mapArchiveStatus(status: "PENDING" | "PACKAGING" | "READY" | "FAILED") {
  return status.toLowerCase() as "pending" | "packaging" | "ready" | "failed";
}

async function batchDetailFromRow(row: typeof batches.$inferSelect, counts: Aggregate): Promise<BatchDetail> {
  return batchDetailSchema.parse({
    id: row.id,
    status: row.status,
    phase: row.phase,
    progress: row.progress,
    counts,
    archive: {
      status: mapArchiveStatus(row.archiveStatus),
      expiresAt: row.archiveStatus === "READY" ? row.artifactsExpireAt?.toISOString() ?? null : undefined,
      ...(row.archiveErrorCode && row.archiveErrorMessage ? { error: { code: row.archiveErrorCode, message: row.archiveErrorMessage } } : {}),
    },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    artifactsExpireAt: row.artifactsExpireAt?.toISOString() ?? null,
  });
}

export async function readBatch(organizationId: string, batchId: string, database: UnoDatabase = getDb()): Promise<BatchDetail> {
  const scoped = await database.select({ id: batches.id }).from(batches).where(and(eq(batches.organizationId, organizationId), eq(batches.id, batchId), notRetired)).limit(1);
  if (!scoped[0]) throw new AppError("not_found", "Lote não encontrado.", 404);
  await reconcileBatch(batchId, database);
  const rows = await database.select().from(batches).where(and(eq(batches.organizationId, organizationId), eq(batches.id, batchId), notRetired)).limit(1);
  if (!rows[0]) throw new AppError("not_found", "Lote não encontrado.", 404);
  return batchDetailFromRow(rows[0], closedAggregate(rows[0]) ?? await aggregateBatch(batchId, database));
}

const batchesQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.uuid().optional() });
export async function listBatches(organizationId: string, rawQuery: unknown = {}, database: UnoDatabase = getDb()): Promise<BatchList> {
  const query = batchesQuerySchema.parse(rawQuery);
  const conditions = [
    eq(batches.organizationId, organizationId),
    sql`${batches.status} not in ('deleting','deleted')`,
  ];
  if (query.cursor) {
    const cursor = await database.select({ id: batches.id, createdAt: batches.createdAt }).from(batches).where(and(
      eq(batches.organizationId, organizationId),
      eq(batches.id, query.cursor),
    )).limit(1);
    if (!cursor[0]) throw new AppError("invalid_cursor", "Cursor inválido.", 400);
    conditions.push(or(
      lt(batches.createdAt, cursor[0].createdAt),
      and(eq(batches.createdAt, cursor[0].createdAt), lt(batches.id, cursor[0].id)),
    )!);
  }
  const rows = await database.select().from(batches).where(and(...conditions))
    .orderBy(desc(batches.createdAt), desc(batches.id)).limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const items = await Promise.all(page.map(async (row) => batchDetailFromRow(row, closedAggregate(row) ?? await aggregateBatch(row.id, database))));
  return batchListSchema.parse({ items, nextCursor: rows.length > query.limit ? page.at(-1)!.id : null });
}

const itemsQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), cursor: z.uuid().optional() });
export async function listBatchItems(
  organizationId: string,
  batchId: string,
  rawQuery: unknown,
  database: UnoDatabase = getDb(),
): Promise<BatchItemsPage> {
  const query = itemsQuerySchema.parse(rawQuery);
  const batch = await database.select({ id: batches.id }).from(batches).where(and(eq(batches.organizationId, organizationId), eq(batches.id, batchId), notRetired)).limit(1);
  if (!batch[0]) throw new AppError("not_found", "Lote não encontrado.", 404);
  const conditions = [
    eq(conversions.organizationId, organizationId),
    eq(conversions.batchId, batchId),
    sql`${conversions.status} not in ('deleting','deleted')`,
  ];
  if (query.cursor) conditions.push(lt(conversions.id, query.cursor));
  const rows = await database.select().from(conversions).where(and(...conditions)).orderBy(desc(conversions.id)).limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  return batchItemsPageSchema.parse({
    items: page.map((row) => ({
      id: row.id,
      status: row.status,
      progress: row.progress,
      originalFileName: row.originalFileName,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      ...(row.status === "failed" && row.errorCode && row.errorMessage ? { error: { code: row.errorCode, message: row.errorMessage } } : {}),
    })),
    nextCursor: rows.length > query.limit ? page.at(-1)!.id : null,
  });
}

export async function signBatchDownload(
  organizationId: string,
  batchId: string,
  dependencies: Pick<BatchDependencies, "database" | "storage" | "now"> = defaults(),
) {
  const rows = await dependencies.database.select().from(batches).where(and(eq(batches.organizationId, organizationId), eq(batches.id, batchId), notRetired)).limit(1);
  const batch = rows[0];
  if (!batch) throw new AppError("not_found", "Lote não encontrado.", 404);
  if (batch.status !== "completed" || batch.archiveStatus !== "READY" || !batch.zipObjectKey || !batch.artifactsExpireAt) {
    throw new AppError("archive_unavailable", "O arquivo do lote não está disponível.", 410);
  }
  if (batch.artifactsExpireAt.getTime() - dependencies.now().getTime() < 1_000) {
    throw new AppError("archive_unavailable", "O arquivo do lote expirou.", 410);
  }
  await dependencies.storage.head(batch.zipObjectKey).catch((error) => {
    if (error instanceof AppError && error.code === "upload_not_found") throw new AppError("archive_unavailable", "O arquivo do lote não está disponível.", 410);
    throw error;
  });
  const seconds = Math.min(300, Math.floor((batch.artifactsExpireAt.getTime() - dependencies.now().getTime()) / 1_000));
  if (seconds < 1) throw new AppError("archive_unavailable", "O arquivo do lote expirou.", 410);
  const signed = await dependencies.storage.signDownload(batch.zipObjectKey, seconds);
  return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
}

export async function reconcilePendingBatches(database: UnoDatabase = getDb()): Promise<number> {
  const rows = await database.select({ id: batches.id }).from(batches).where(sql`${batches.status} in ('queued','processing')`).limit(50);
  for (const row of rows) await reconcileBatch(row.id, database);
  return rows.length;
}

export type { BatchDependencies, BatchCommitInput, BatchCommitResult };
