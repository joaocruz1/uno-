import { createHash, randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import {
  conversions,
  getDb,
  outboxEvents,
  subscriptions,
  templates,
  type UnoDatabase,
} from "@/db";
import { QuotaExceededError, reserveUsage } from "@/db/usage";
import { AppError } from "@/lib/errors";
import { outputSizeSchema, sizeDimensions, type OutputSize } from "@/lib/label-size";
import { getPlanCatalog, type PlanId } from "@/lib/plans";
import type { Actor } from "@/server/auth/actor";
import { assertUsageAvailable, effectivePlanFromSubscription, lockCurrentUsagePeriod } from "@/server/billing/entitlements";
import { enforceRateLimit } from "@/server/rate-limit";
import { publishPendingConversionJobs } from "@/server/queue/outbox";
import { getStorage, type StorageGateway } from "@/server/storage";

import { assertTemplateEligible, findTemplate, parseTemplateReference } from "./templates";

export const reprocessConversionInputSchema = z.object({
  size: outputSizeSchema.optional(),
  template: z.string().max(128).optional(),
}).strict();

const idempotencyKeySchema = z.string().min(16).max(128).regex(/^[\x21-\x7e]+$/);

type SourceConversion = {
  id: string;
  organizationId: string;
  status: "queued" | "processing" | "completed" | "failed" | "deleting" | "deleted";
  originalFileName: string | null;
  inputObjectKey: string;
  inputSha256: string | null;
  sourceByteLength: number;
  artifactsExpireAt: Date | null;
  outputPreset: string;
  productHeader?: { quantity: number; title: string; sku?: string; variation?: string } | null;
  outputWidthMm: string;
  outputHeightMm: string;
  templateKey: string;
  templateVersion: string;
};

type EffectiveRequest = {
  template: string;
  size: OutputSize;
  requestHash: string;
};

export type ReprocessedConversion = {
  id: string;
  status: "queued" | "processing" | "completed" | "failed";
  progress: number;
  createdAt: string;
};

type CommitInput = {
  actor: Pick<Actor, "organizationId" | "userId">;
  source: SourceConversion;
  request: EffectiveRequest;
  idempotencyKey: string;
  snapshotKey: string;
  conversionId: string;
  reservationId: string;
  outboxId: string;
  now(): Date;
};

type CommitResult = {
  conversion: ReprocessedConversion;
  outboxId?: string;
  snapshotCommitted: boolean;
};

export type ReprocessDependencies = {
  database: UnoDatabase;
  storage: StorageGateway;
  enforceRateLimit(actor: Pick<Actor, "organizationId" | "planId">): Promise<void>;
  publish(eventId: string): Promise<void>;
  commit(input: CommitInput): Promise<CommitResult>;
  recoverCommit(input: CommitInput): Promise<CommitResult | null>;
  randomId(): string;
  now(): Date;
};

function defaults(): ReprocessDependencies {
  const database = getDb();
  return {
    database,
    storage: getStorage(),
    randomId: randomUUID,
    now: () => new Date(),
    async enforceRateLimit(actor) {
      await enforceRateLimit({
        namespace: "dashboard-reprocess",
        identifier: actor.organizationId,
        limit: getPlanCatalog()[actor.planId].rateLimit || 30,
      });
    },
    async publish(eventId) {
      await publishPendingConversionJobs({ eventId, limit: 1 });
    },
    commit: (input) => commitReprocessedConversion(input, database),
    recoverCommit: (input) => recoverReprocessCommit(input, database),
  };
}

function retentionDate(now: Date, planId: PlanId): Date {
  return new Date(now.getTime() + getPlanCatalog()[planId].retentionDays * 86_400_000);
}

function sourceSize(source: SourceConversion): OutputSize {
  if (source.outputPreset === "custom") {
    return outputSizeSchema.parse({
      preset: "custom",
      widthMm: Number(source.outputWidthMm),
      heightMm: Number(source.outputHeightMm),
    });
  }
  return outputSizeSchema.parse({ preset: source.outputPreset });
}

function effectiveRequest(source: SourceConversion, rawInput: unknown): EffectiveRequest {
  const input = reprocessConversionInputSchema.parse(rawInput);
  const request = {
    template: input.template ?? `${source.templateKey}@${source.templateVersion}`,
    size: input.size ?? sourceSize(source),
  };
  parseTemplateReference(request.template);
  return {
    ...request,
    requestHash: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
  };
}

function publicConversion(row: {
  id: string;
  status: string;
  progress: number;
  createdAt: Date;
}): ReprocessedConversion {
  if (!["queued", "processing", "completed", "failed"].includes(row.status)) {
    throw new AppError("not_found", "Conversão não encontrada.", 404);
  }
  return {
    id: row.id,
    status: row.status as ReprocessedConversion["status"],
    progress: row.progress,
    createdAt: row.createdAt.toISOString(),
  };
}

async function loadSource(
  organizationId: string,
  conversionId: string,
  database: Pick<UnoDatabase, "select">,
): Promise<SourceConversion> {
  const rows = await database.select({
    id: conversions.id,
    organizationId: conversions.organizationId,
    status: conversions.status,
    originalFileName: conversions.originalFileName,
    inputObjectKey: conversions.inputObjectKey,
    inputSha256: conversions.inputSha256,
    sourceByteLength: conversions.sourceByteLength,
    artifactsExpireAt: conversions.artifactsExpireAt,
    outputPreset: conversions.outputPreset,
    productHeader: conversions.productHeader,
    outputWidthMm: conversions.outputWidthMm,
    outputHeightMm: conversions.outputHeightMm,
    templateKey: templates.key,
    templateVersion: conversions.templateVersion,
  }).from(conversions).innerJoin(templates, eq(templates.id, conversions.templateId)).where(and(
    eq(conversions.organizationId, organizationId),
    eq(conversions.id, conversionId),
  )).limit(1);
  const source = rows[0];
  if (!source || source.status === "deleting" || source.status === "deleted") {
    throw new AppError("not_found", "Conversão não encontrada.", 404);
  }
  return source;
}

async function findIdempotentConversion(
  organizationId: string,
  sourceConversionId: string,
  idempotencyKey: string,
  requestHash: string,
  database: Pick<UnoDatabase, "select">,
): Promise<ReprocessedConversion | null> {
  const rows = await database.select({
    id: conversions.id,
    status: conversions.status,
    progress: conversions.progress,
    createdAt: conversions.createdAt,
    requestHash: conversions.reprocessRequestHash,
  }).from(conversions).where(and(
    eq(conversions.organizationId, organizationId),
    eq(conversions.sourceConversionId, sourceConversionId),
    eq(conversions.reprocessIdempotencyKey, idempotencyKey),
  )).limit(1);
  const existing = rows[0];
  if (!existing) return null;
  if (existing.requestHash !== requestHash) {
    throw new AppError("idempotency_conflict", "A chave de idempotência já foi usada com outros parâmetros.", 409);
  }
  return publicConversion(existing);
}

function assertSourceUsable(source: SourceConversion, now: Date): void {
  if (source.status === "queued" || source.status === "processing") {
    throw new AppError("conversion_active", "A conversão ainda está em processamento.", 409);
  }
  if (!source.artifactsExpireAt || source.artifactsExpireAt <= now || !source.inputSha256) {
    throw new AppError("source_unavailable", "O arquivo de origem não está mais disponível.", 410);
  }
}

function sourceUnavailable(error: unknown): never {
  if (error instanceof AppError && error.code === "upload_not_found") {
    throw new AppError("source_unavailable", "O arquivo de origem não está mais disponível.", 410);
  }
  throw error;
}

async function readSourceBytes(source: SourceConversion, storage: StorageGateway): Promise<Buffer> {
  try {
    const head = await storage.head(source.inputObjectKey);
    if (head.contentLength !== source.sourceByteLength) {
      throw new AppError("source_unavailable", "O arquivo de origem não está mais disponível.", 410);
    }
    const bytes = await storage.read(source.inputObjectKey, source.sourceByteLength);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== source.sourceByteLength || hash !== source.inputSha256) {
      throw new AppError("source_unavailable", "O arquivo de origem não está mais disponível.", 410);
    }
    return bytes;
  } catch (error) {
    return sourceUnavailable(error);
  }
}

async function lockedIdempotentResult(
  input: CommitInput,
  transaction: UnoDatabase,
): Promise<CommitResult | null> {
  const rows = await transaction.select({
    id: conversions.id,
    status: conversions.status,
    progress: conversions.progress,
    createdAt: conversions.createdAt,
    requestHash: conversions.reprocessRequestHash,
    inputObjectKey: conversions.inputObjectKey,
  }).from(conversions).where(and(
    eq(conversions.organizationId, input.actor.organizationId),
    eq(conversions.sourceConversionId, input.source.id),
    eq(conversions.reprocessIdempotencyKey, input.idempotencyKey),
  )).limit(1);
  const existing = rows[0];
  if (!existing) return null;
  if (existing.requestHash !== input.request.requestHash) {
    throw new AppError("idempotency_conflict", "A chave de idempotência já foi usada com outros parâmetros.", 409);
  }
  return {
    conversion: publicConversion(existing),
    snapshotCommitted: existing.inputObjectKey === input.snapshotKey,
  };
}

export async function commitReprocessedConversion(input: CommitInput, database: UnoDatabase = getDb()): Promise<CommitResult> {
  return database.transaction(async (transaction) => {
    const sources = await transaction.select().from(conversions).where(and(
      eq(conversions.organizationId, input.actor.organizationId),
      eq(conversions.id, input.source.id),
    )).limit(1).for("update");
    const source = sources[0];
    if (!source || source.status === "deleting" || source.status === "deleted") {
      throw new AppError("not_found", "Conversão não encontrada.", 404);
    }

    const existing = await lockedIdempotentResult(input, transaction);
    if (existing) return existing;
    const sourceNow = input.now();
    if (source.status === "queued" || source.status === "processing") {
      throw new AppError("conversion_active", "A conversão ainda está em processamento.", 409);
    }
    if (
      !source.artifactsExpireAt || source.artifactsExpireAt <= sourceNow ||
      source.inputSha256 !== input.source.inputSha256 || source.inputObjectKey !== input.source.inputObjectKey ||
      source.sourceByteLength !== input.source.sourceByteLength
    ) {
      throw new AppError("source_unavailable", "O arquivo de origem não está mais disponível.", 410);
    }

    const template = await findTemplate(input.request.template, transaction);
    assertTemplateEligible(template, input.request.size);
    const subscriptionRows = await transaction.select({
      planId: subscriptions.planId,
      status: subscriptions.status,
      currentPeriodStart: subscriptions.currentPeriodStart,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
    }).from(subscriptions).where(eq(subscriptions.organizationId, input.actor.organizationId)).limit(1).for("update");
    const subscription = subscriptionRows[0];
    const decisionNow = input.now();
    if (!source.artifactsExpireAt || source.artifactsExpireAt <= decisionNow) {
      throw new AppError("source_unavailable", "O arquivo de origem não está mais disponível.", 410);
    }
    const entitlement = effectivePlanFromSubscription(subscription, decisionNow);
    const planId = entitlement.planId;
    if (source.sourceByteLength > entitlement.plan.maxFileMB * 1_024 * 1_024) {
      throw new AppError("file_too_large", "O arquivo excede o limite permitido pelo plano atual.", 413);
    }
    const usagePeriod = await lockCurrentUsagePeriod(input.actor.organizationId, entitlement, decisionNow, transaction);
    assertUsageAvailable(usagePeriod, entitlement.plan.monthlyLimit);

    const dimensions = sizeDimensions(input.request.size);
    const createdRows = await transaction.insert(conversions).values({
      id: input.conversionId,
      organizationId: input.actor.organizationId,
      createdByUserId: input.actor.userId,
      sourceConversionId: source.id,
      reprocessIdempotencyKey: input.idempotencyKey,
      reprocessRequestHash: input.request.requestHash,
      templateId: template.id,
      templateVersion: template.version,
      engineVersion: template.engineVersion,
      status: "queued",
      source: "dashboard",
      originalFileName: source.originalFileName,
      progress: 0,
      currentStage: "queued",
      outputPreset: input.request.size.preset,
      productHeader: source.productHeader ?? null,
      outputWidthMm: String(dimensions.widthMm),
      outputHeightMm: String(dimensions.heightMm),
      inputObjectKey: input.snapshotKey,
      inputSha256: source.inputSha256,
      sourceByteLength: source.sourceByteLength,
      artifactsExpireAt: retentionDate(decisionNow, planId),
      queuedAt: decisionNow,
      createdAt: decisionNow,
      updatedAt: decisionNow,
    }).returning({ id: conversions.id, status: conversions.status, progress: conversions.progress, createdAt: conversions.createdAt });

    try {
      await reserveUsage({
        reservationId: input.reservationId,
        organizationId: input.actor.organizationId,
        usagePeriodId: usagePeriod.id,
        conversionId: input.conversionId,
      }, transaction);
    } catch (error) {
      if (error instanceof QuotaExceededError) {
        throw new AppError("quota_exceeded", "A organização atingiu a cota mensal.", 403);
      }
      throw error;
    }
    await transaction.insert(outboxEvents).values({
      id: input.outboxId,
      organizationId: input.actor.organizationId,
      type: "conversion.queued",
      aggregateType: "conversion",
      aggregateId: input.conversionId,
      deduplicationKey: `conversion.queued.${input.conversionId}`,
      payload: { conversionId: input.conversionId },
    });
    return {
      conversion: publicConversion(createdRows[0]!),
      outboxId: input.outboxId,
      snapshotCommitted: true,
    };
  });
}

export async function recoverReprocessCommit(input: CommitInput, database: UnoDatabase): Promise<CommitResult | null> {
  return database.transaction(async (transaction) => {
    await transaction.select({ id: conversions.id }).from(conversions).where(and(
      eq(conversions.organizationId, input.actor.organizationId),
      eq(conversions.id, input.source.id),
    )).limit(1).for("update");
    const existing = await lockedIdempotentResult(input, transaction);
    if (!existing) return null;
    if (!existing.snapshotCommitted) return existing;
    const events = await transaction.select({ id: outboxEvents.id }).from(outboxEvents).where(and(
      eq(outboxEvents.organizationId, input.actor.organizationId),
      eq(outboxEvents.aggregateId, existing.conversion.id),
      eq(outboxEvents.type, "conversion.queued"),
    )).limit(1);
    if (!events[0]) throw new Error("reprocess_commit_recovery_inconsistent");
    return { ...existing, outboxId: events[0].id };
  });
}

export async function reprocessConversion(
  actor: Pick<Actor, "organizationId" | "userId" | "planId">,
  sourceConversionId: string,
  idempotencyKey: string | null,
  rawInput: unknown,
  dependencies: ReprocessDependencies = defaults(),
): Promise<ReprocessedConversion> {
  const parsedKey = idempotencyKeySchema.safeParse(idempotencyKey);
  if (!parsedKey.success) throw new AppError("invalid_idempotency_key", "Idempotency-Key inválida.", 400);
  await dependencies.enforceRateLimit(actor);

  const source = await loadSource(actor.organizationId, sourceConversionId, dependencies.database);
  const request = effectiveRequest(source, rawInput);
  const existing = await findIdempotentConversion(
    actor.organizationId,
    source.id,
    parsedKey.data,
    request.requestHash,
    dependencies.database,
  );
  if (existing) return existing;
  const now = dependencies.now();
  assertSourceUsable(source, now);
  const bytes = await readSourceBytes(source, dependencies.storage);
  const conversionId = dependencies.randomId();
  const snapshotKey = `organizations/${actor.organizationId}/conversion-inputs/${dependencies.randomId()}.pdf`;
  await dependencies.storage.putBytes(snapshotKey, bytes, "application/pdf", source.sourceByteLength);

  const commitInput: CommitInput = {
    actor,
    source,
    request,
    idempotencyKey: parsedKey.data,
    snapshotKey,
    conversionId,
    reservationId: dependencies.randomId(),
    outboxId: dependencies.randomId(),
    now: dependencies.now,
  };
  let committed: CommitResult;
  try {
    committed = await dependencies.commit(commitInput);
  } catch (error) {
    try {
      const recovered = await dependencies.recoverCommit(commitInput);
      if (!recovered) {
        await dependencies.storage.delete(snapshotKey).catch(() => undefined);
        throw error;
      }
      committed = recovered;
    } catch (recoveryError) {
      if (recoveryError === error || (recoveryError instanceof AppError && recoveryError.code === "idempotency_conflict")) {
        await dependencies.storage.delete(snapshotKey).catch(() => undefined);
        throw recoveryError;
      }
      // A database outage can hide a committed row. Preserve the immutable copy.
      throw error;
    }
  }
  if (!committed.snapshotCommitted) {
    await dependencies.storage.delete(snapshotKey).catch(() => undefined);
  }
  if (committed.outboxId) await dependencies.publish(committed.outboxId).catch(() => undefined);
  return committed.conversion;
}

export type { CommitInput as ReprocessCommitInput, EffectiveRequest, SourceConversion };
