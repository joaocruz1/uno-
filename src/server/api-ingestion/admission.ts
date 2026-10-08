import { createHash, randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";

import {
  apiRequests,
  apiRequestUploads,
  batches,
  conversions,
  getDb,
  outboxEvents,
  subscriptions,
  type UnoDatabase,
} from "@/db";
import { QuotaExceededError, reserveUsage } from "@/db/usage";
import { acceptedBatchSchema, type AcceptedBatch } from "@/lib/batch-model";
import { acceptedConversionSchema } from "@/lib/conversion-model";
import { AppError } from "@/lib/errors";
import { parseOutputSize, sizeDimensions, type OutputSize } from "@/lib/label-size";
import { parseProductFields, type ProductHeader } from "@/lib/product-header";
import { assertUsageAvailable, effectivePlanFromSubscription, lockCurrentUsagePeriod, subscriptionEntitlementColumns } from "@/server/billing/entitlements";
import { publishPendingConversionJobs } from "@/server/queue/outbox";
import { assertTemplateEligible, findTemplate, INITIAL_TEMPLATE, seedInitialDraftTemplate } from "@/server/conversions/templates";

import { requireFreshApiActor, type ApiActor } from "../api-keys";
import { cleanupPreparedUploads, type ParsedApiMultipart, type PreparedApiUpload } from "./parser";

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{16,128}$/;
const STALE_PREPARATION_MS = 30 * 60_000;

export type PublicRequestClaim = {
  id: string;
  attempt: number;
  replay: boolean;
  idempotencyKey: string | null;
};

export type EffectiveMultipartOptions = {
  template: string;
  size: OutputSize;
  product?: ProductHeader;
};

type AdmissionDependencies = {
  database: UnoDatabase;
  randomId(): string;
  now(): Date;
  publish(eventId: string): Promise<void>;
  cleanup(organizationId: string, apiRequestId: string, attempt: number): Promise<void>;
};

function defaults(): AdmissionDependencies {
  return {
    database: getDb(), randomId: randomUUID, now: () => new Date(),
    publish: async (eventId) => { await publishPendingConversionJobs({ eventId, limit: 1 }); },
    cleanup: cleanupPreparedUploads,
  };
}

export function parseEffectiveMultipartOptions(fields: Record<string, string>): EffectiveMultipartOptions {
  if (fields.size !== "custom" && (fields.widthMm !== undefined || fields.heightMm !== undefined)) {
    throw new AppError("invalid_request", "widthMm e heightMm são permitidos somente para size=custom.", 400);
  }
  if (fields.size === "custom" && (fields.widthMm === undefined || fields.heightMm === undefined)) {
    throw new AppError("invalid_request", "widthMm e heightMm são obrigatórios para size=custom.", 400);
  }
  let size: OutputSize;
  try {
    size = parseOutputSize(fields);
  } catch {
    throw new AppError("invalid_request", "Formato de saída inválido.", 400);
  }
  const template = fields.template?.trim() || INITIAL_TEMPLATE;
  if (template.length > 128) throw new AppError("invalid_request", "Modelo inválido.", 400);
  let product: ProductHeader | undefined;
  try {
    product = parseProductFields(fields);
  } catch {
    throw new AppError("invalid_request", "Dados do produto inválidos: informe productTitle e, se desejar, quantity, sku e variation.", 400);
  }
  return { template, size, ...(product ? { product } : {}) };
}

export function publicRequestFingerprint(options: EffectiveMultipartOptions, files: PreparedApiUpload[]): string {
  return createHash("sha256").update(JSON.stringify({
    template: options.template,
    size: options.size,
    ...(options.product ? { product: options.product } : {}),
    files: files.map((file) => ({
      name: file.originalFileName,
      length: file.contentLength,
      sha256: file.checksumSha256,
    })),
  })).digest("hex");
}

export async function beginPublicRequest(
  actor: ApiActor,
  input: { route: string; method: "POST"; idempotencyKey: string | null; requestId: string },
  dependencies: Pick<AdmissionDependencies, "database" | "randomId" | "now"> = defaults(),
): Promise<PublicRequestClaim> {
  if (input.idempotencyKey && !IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
    throw new AppError("invalid_idempotency_key", "Idempotency-Key inválida.", 400);
  }
  return dependencies.database.transaction(async (transaction) => {
    const now = dependencies.now();
    if (input.idempotencyKey) {
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${actor.organizationId}:${input.route}:${input.idempotencyKey}`}, 37))`);
      const rows = await transaction.select().from(apiRequests).where(and(
        eq(apiRequests.organizationId, actor.organizationId),
        eq(apiRequests.route, input.route),
        eq(apiRequests.idempotencyKey, input.idempotencyKey),
      )).limit(1).for("update");
      const existing = rows[0];
      if (existing) {
        if (existing.status === "PENDING" && existing.updatedAt > new Date(now.getTime() - STALE_PREPARATION_MS)) {
          throw new AppError("idempotency_in_progress", "Uma solicitação com esta chave ainda está em preparação.", 409, { retryAfterSeconds: 5 });
        }
        const attempt = existing.attempts + 1;
        await transaction.update(apiRequests).set({
          attempts: attempt,
          ...(existing.status === "COMPLETED" ? {} : { status: "PENDING" as const, requestHash: null, responseStatus: null, responseBody: null, resourceType: null, resourceId: null, completedAt: null }),
          updatedAt: now,
        }).where(eq(apiRequests.id, existing.id));
        return { id: existing.id, attempt, replay: existing.status === "COMPLETED", idempotencyKey: input.idempotencyKey };
      }
    }
    const id = dependencies.randomId();
    await transaction.insert(apiRequests).values({
      id,
      organizationId: actor.organizationId,
      apiKeyId: actor.apiKeyId,
      requestId: input.requestId,
      method: input.method,
      route: input.route,
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
      updatedAt: now,
    });
    return { id, attempt: 1, replay: false, idempotencyKey: input.idempotencyKey };
  });
}

export async function failPublicRequest(
  organizationId: string,
  claim: PublicRequestClaim,
  database: UnoDatabase = getDb(),
  now = new Date(),
): Promise<void> {
  if (claim.replay) return;
  await database.update(apiRequests).set({ status: "FAILED", updatedAt: now, completedAt: now }).where(and(
    eq(apiRequests.organizationId, organizationId),
    eq(apiRequests.id, claim.id),
    eq(apiRequests.attempts, claim.attempt),
    eq(apiRequests.status, "PENDING"),
  )).catch(() => undefined);
}

async function replayResponse<T>(
  actor: ApiActor,
  claim: PublicRequestClaim,
  requestHash: string,
  dependencies: AdmissionDependencies,
): Promise<T | null> {
  if (!claim.replay) return null;
  // A replay never owns the snapshot it just uploaded; the original resource keeps its own.
  await dependencies.cleanup(actor.organizationId, claim.id, claim.attempt).catch(() => undefined);
  const rows = await dependencies.database.select().from(apiRequests).where(and(
    eq(apiRequests.organizationId, actor.organizationId), eq(apiRequests.id, claim.id),
  )).limit(1);
  const row = rows[0];
  if (!row || row.status !== "COMPLETED" || !row.responseBody || row.requestHash !== requestHash) {
    throw new AppError("idempotency_conflict", "A chave de idempotência já foi usada com outro conteúdo.", 409);
  }
  return row.responseBody as T;
}

function retentionAt(now: Date, days: number) {
  return new Date(now.getTime() + days * 86_400_000);
}

async function insertConversion(
  input: {
    actor: ApiActor;
    file: PreparedApiUpload;
    batchId?: string;
    template: Awaited<ReturnType<typeof findTemplate>>;
    options: EffectiveMultipartOptions;
    conversionId: string;
    now: Date;
    artifactsExpireAt: Date;
  },
  transaction: UnoDatabase,
) {
  const dimensions = sizeDimensions(input.options.size);
  await transaction.insert(conversions).values({
    id: input.conversionId,
    organizationId: input.actor.organizationId,
    apiKeyId: input.actor.apiKeyId,
    batchId: input.batchId,
    templateId: input.template.id,
    templateVersion: input.template.version,
    engineVersion: input.template.engineVersion,
    status: "queued",
    source: "api",
    originalFileName: input.file.originalFileName,
    progress: 0,
    currentStage: "queued",
    outputPreset: input.options.size.preset,
    productHeader: input.options.product ?? null,
    outputWidthMm: String(dimensions.widthMm),
    outputHeightMm: String(dimensions.heightMm),
    inputObjectKey: input.file.objectKey,
    inputSha256: input.file.checksumSha256,
    sourceByteLength: input.file.contentLength,
    artifactsExpireAt: input.artifactsExpireAt,
    queuedAt: input.now,
    createdAt: input.now,
    updatedAt: input.now,
  });
}

async function assertPreparedAttempt(
  actor: ApiActor,
  claim: PublicRequestClaim,
  files: PreparedApiUpload[],
  transaction: UnoDatabase,
): Promise<void> {
  const rows = await transaction.select().from(apiRequestUploads).where(and(
    eq(apiRequestUploads.organizationId, actor.organizationId),
    eq(apiRequestUploads.apiRequestId, claim.id),
    eq(apiRequestUploads.attempt, claim.attempt),
    inArray(apiRequestUploads.id, files.map((file) => file.trackingId)),
  )).for("update");
  if (rows.length !== files.length || files.some((file) => {
    const row = rows.find((candidate) => candidate.id === file.trackingId);
    return !row || row.status !== "READY" || row.objectKey !== file.objectKey ||
      row.contentLength !== file.contentLength || row.checksumSha256 !== file.checksumSha256 ||
      row.ordinal !== file.ordinal;
  })) {
    throw new AppError("invalid_request", "A preparação dos arquivos não está mais disponível.", 409);
  }
}

async function recoverPublicCommit<T>(
  actor: ApiActor,
  claim: PublicRequestClaim,
  requestHash: string,
  database: UnoDatabase,
): Promise<T | null> {
  return database.transaction(async (transaction) => {
    const rows = await transaction.select().from(apiRequests).where(and(
      eq(apiRequests.organizationId, actor.organizationId), eq(apiRequests.id, claim.id),
    )).limit(1).for("update");
    const row = rows[0];
    if (!row || row.status !== "COMPLETED") return null;
    if (row.requestHash !== requestHash || !row.responseBody) throw new AppError("idempotency_conflict", "A chave de idempotência já foi usada com outro conteúdo.", 409);
    return row.responseBody as T;
  });
}

export async function admitPublicConversion(
  actor: ApiActor,
  claim: PublicRequestClaim,
  parsed: ParsedApiMultipart,
  dependencies: AdmissionDependencies = defaults(),
) {
  const options = parseEffectiveMultipartOptions(parsed.fields);
  const requestHash = publicRequestFingerprint(options, parsed.files);
  const replay = await replayResponse<ReturnType<typeof acceptedConversionSchema.parse>>(actor, claim, requestHash, dependencies);
  if (replay) return replay;
  const conversionId = dependencies.randomId();
  const reservationId = dependencies.randomId();
  const outboxId = dependencies.randomId();
  try {
    const accepted = await dependencies.database.transaction(async (transaction) => {
      const requestRows = await transaction.select().from(apiRequests).where(and(
        eq(apiRequests.organizationId, actor.organizationId), eq(apiRequests.id, claim.id),
      )).limit(1).for("update");
      const request = requestRows[0];
      if (!request || request.status !== "PENDING" || request.attempts !== claim.attempt) throw new AppError("idempotency_conflict", "A solicitação não pode mais ser concluída.", 409);
      await assertPreparedAttempt(actor, claim, parsed.files, transaction);
      const decisionNow = dependencies.now();
      const freshActor = await requireFreshApiActor(actor, transaction, decisionNow);
      if (process.env.NODE_ENV !== "production" && process.env.UNO_ALLOW_DRAFT_TEMPLATES === "true") await seedInitialDraftTemplate(transaction);
      const template = await findTemplate(options.template, transaction);
      assertTemplateEligible(template, options.size);
      const subscriptionRows = await transaction.select({
        ...subscriptionEntitlementColumns,
      }).from(subscriptions).where(eq(subscriptions.organizationId, actor.organizationId)).limit(1).for("update");
      const entitlement = effectivePlanFromSubscription(subscriptionRows[0], decisionNow);
      const file = parsed.files[0]!;
      if (file.contentLength > entitlement.plan.maxFileMB * 1_024 * 1_024) throw new AppError("file_too_large", "O arquivo excede o limite permitido pelo plano.", 413);
      const period = await lockCurrentUsagePeriod(actor.organizationId, entitlement, decisionNow, transaction);
      assertUsageAvailable(period, entitlement.plan.monthlyLimit);
      await insertConversion({ actor: freshActor, file, template, options, conversionId, now: decisionNow, artifactsExpireAt: retentionAt(decisionNow, entitlement.plan.retentionDays) }, transaction);
      try {
        await reserveUsage({ reservationId, organizationId: actor.organizationId, usagePeriodId: period.id, conversionId }, transaction);
      } catch (error) {
        if (error instanceof QuotaExceededError) throw new AppError("quota_exceeded", "A organização atingiu a cota mensal.", 403);
        throw error;
      }
      await transaction.insert(outboxEvents).values({
        id: outboxId, organizationId: actor.organizationId, type: "conversion.queued", aggregateType: "conversion", aggregateId: conversionId,
        deduplicationKey: `conversion.queued.${conversionId}`, payload: { conversionId },
      });
      const body = acceptedConversionSchema.parse({ id: conversionId, status: "queued", progress: 0, createdAt: decisionNow.toISOString() });
      await transaction.update(apiRequestUploads).set({ status: "COMMITTED", committedAt: decisionNow, updatedAt: decisionNow }).where(and(
        eq(apiRequestUploads.organizationId, actor.organizationId), eq(apiRequestUploads.apiRequestId, claim.id), eq(apiRequestUploads.attempt, claim.attempt),
      ));
      await transaction.update(apiRequests).set({
        requestHash, status: "COMPLETED", responseStatus: 202, responseBody: body,
        resourceType: "conversion", resourceId: conversionId, completedAt: decisionNow, updatedAt: decisionNow,
      }).where(eq(apiRequests.id, claim.id));
      return body;
    });
    await dependencies.publish(outboxId).catch(() => undefined);
    return accepted;
  } catch (error) {
    let recovered: Awaited<ReturnType<typeof acceptedConversionSchema.parse>> | null;
    try { recovered = await recoverPublicCommit(actor, claim, requestHash, dependencies.database); } catch { throw error; }
    if (recovered) { await dependencies.publish(outboxId).catch(() => undefined); return recovered; }
    await dependencies.cleanup(actor.organizationId, claim.id, claim.attempt).catch(() => undefined);
    await failPublicRequest(actor.organizationId, claim, dependencies.database, dependencies.now());
    throw error;
  }
}

export async function admitPublicBatch(
  actor: ApiActor,
  claim: PublicRequestClaim,
  parsed: ParsedApiMultipart,
  dependencies: AdmissionDependencies = defaults(),
): Promise<AcceptedBatch> {
  const options = parseEffectiveMultipartOptions(parsed.fields);
  if (options.product) {
    await dependencies.cleanup(actor.organizationId, claim.id, claim.attempt).catch(() => undefined);
    throw new AppError("invalid_request", "Dados de produto são aceitos somente em conversões individuais.", 400);
  }
  const requestHash = publicRequestFingerprint(options, parsed.files);
  const replay = await replayResponse<AcceptedBatch>(actor, claim, requestHash, dependencies);
  if (replay) return acceptedBatchSchema.parse(replay);
  const batchId = dependencies.randomId();
  const prepared = parsed.files.map((file) => ({ file, conversionId: dependencies.randomId(), reservationId: dependencies.randomId(), outboxId: dependencies.randomId() }));
  try {
    const accepted = await dependencies.database.transaction(async (transaction) => {
      const requestRows = await transaction.select().from(apiRequests).where(and(
        eq(apiRequests.organizationId, actor.organizationId), eq(apiRequests.id, claim.id),
      )).limit(1).for("update");
      const request = requestRows[0];
      if (!request || request.status !== "PENDING" || request.attempts !== claim.attempt) throw new AppError("idempotency_conflict", "A solicitação não pode mais ser concluída.", 409);
      await assertPreparedAttempt(actor, claim, parsed.files, transaction);
      const decisionNow = dependencies.now();
      const freshActor = await requireFreshApiActor(actor, transaction, decisionNow);
      if (process.env.NODE_ENV !== "production" && process.env.UNO_ALLOW_DRAFT_TEMPLATES === "true") await seedInitialDraftTemplate(transaction);
      const template = await findTemplate(options.template, transaction);
      assertTemplateEligible(template, options.size);
      const subscriptionRows = await transaction.select({
        ...subscriptionEntitlementColumns,
      }).from(subscriptions).where(eq(subscriptions.organizationId, actor.organizationId)).limit(1).for("update");
      const entitlement = effectivePlanFromSubscription(subscriptionRows[0], decisionNow);
      if (prepared.length > entitlement.plan.batchLimit) throw new AppError("batch_limit_exceeded", "O lote excede o limite do plano atual.", 413);
      if (prepared.some(({ file }) => file.contentLength > entitlement.plan.maxFileMB * 1_024 * 1_024)) throw new AppError("file_too_large", "Um arquivo excede o limite permitido pelo plano.", 413);
      const period = await lockCurrentUsagePeriod(actor.organizationId, entitlement, decisionNow, transaction);
      assertUsageAvailable(period, entitlement.plan.monthlyLimit, prepared.length);
      const expiresAt = retentionAt(decisionNow, entitlement.plan.retentionDays);
      await transaction.insert(batches).values({
        id: batchId, organizationId: actor.organizationId, apiKeyId: freshActor.apiKeyId,
        status: "queued", phase: "queued", itemCount: prepared.length, progress: 0,
        artifactsExpireAt: expiresAt, createdAt: decisionNow, updatedAt: decisionNow,
      });
      try {
        for (const item of prepared) {
          await insertConversion({ actor: freshActor, file: item.file, batchId, template, options, conversionId: item.conversionId, now: decisionNow, artifactsExpireAt: expiresAt }, transaction);
          await reserveUsage({ reservationId: item.reservationId, organizationId: actor.organizationId, usagePeriodId: period.id, conversionId: item.conversionId }, transaction);
          await transaction.insert(outboxEvents).values({
            id: item.outboxId, organizationId: actor.organizationId, type: "conversion.queued", aggregateType: "conversion", aggregateId: item.conversionId,
            deduplicationKey: `conversion.queued.${item.conversionId}`, payload: { conversionId: item.conversionId },
          });
        }
      } catch (error) {
        if (error instanceof QuotaExceededError) throw new AppError("quota_exceeded", "A organização atingiu a cota mensal.", 403);
        throw error;
      }
      const body = acceptedBatchSchema.parse({ id: batchId, status: "queued", progress: 0, itemCount: prepared.length, createdAt: decisionNow.toISOString() });
      await transaction.update(apiRequestUploads).set({ status: "COMMITTED", committedAt: decisionNow, updatedAt: decisionNow }).where(and(
        eq(apiRequestUploads.organizationId, actor.organizationId), eq(apiRequestUploads.apiRequestId, claim.id), eq(apiRequestUploads.attempt, claim.attempt),
      ));
      await transaction.update(apiRequests).set({
        requestHash, status: "COMPLETED", responseStatus: 202, responseBody: body,
        resourceType: "batch", resourceId: batchId, completedAt: decisionNow, updatedAt: decisionNow,
      }).where(eq(apiRequests.id, claim.id));
      return body;
    });
    await Promise.allSettled(prepared.slice(0, 10).map(({ outboxId }) => dependencies.publish(outboxId)));
    return accepted;
  } catch (error) {
    let recovered: AcceptedBatch | null;
    try { recovered = await recoverPublicCommit(actor, claim, requestHash, dependencies.database); } catch { throw error; }
    if (recovered) return acceptedBatchSchema.parse(recovered);
    await dependencies.cleanup(actor.organizationId, claim.id, claim.attempt).catch(() => undefined);
    await failPublicRequest(actor.organizationId, claim, dependencies.database, dependencies.now());
    throw error;
  }
}

export type { AdmissionDependencies };
