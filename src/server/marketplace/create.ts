import { createHash, randomUUID } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { batches, conversions, getDb, outboxEvents, subscriptions, uploadIntents, type UnoDatabase } from "@/db";
import { QuotaExceededError, reserveUsage } from "@/db/usage";
import { splitIntoOrderPdfs } from "@/engine/marketplace/pdf";
import { AppError } from "@/lib/errors";
import { outputSizeSchema, sizeDimensions } from "@/lib/label-size";
import type { Actor } from "@/server/auth/actor";
import {
  assertUsageAvailable,
  effectivePlanFromSubscription,
  lockCurrentUsagePeriod,
  subscriptionEntitlementColumns,
} from "@/server/billing/entitlements";
import { assertTemplateEligible, findTemplate, INITIAL_TEMPLATE, seedInitialDraftTemplate } from "@/server/conversions/templates";
import { publishPendingConversionJobs } from "@/server/queue/outbox";
import { getStorage, type StorageGateway } from "@/server/storage";
import { findUploadIntentForOrganization, readValidatedUpload, type ReadValidatedUpload, type UploadIntentRecord } from "@/server/uploads";

/** Marketplaces the lote pipeline can ingest, and how many pages make up one order. */
const MARKETPLACE_PAGES_PER_ORDER: Record<string, number> = { "mercado-livre": 2 };

export const labelNumberingSchema = z.object({
  letter: z.string().regex(/^[A-Z]{1,3}$/).optional(),
  start: z.number().int().min(1).max(99_999),
  showTotal: z.boolean(),
}).strict();

/** Up to this many files can be sent in one lote (reorderable multi-upload). */
export const MAX_LOTE_FILES = 10;

export const createMarketplaceLoteInputSchema = z.object({
  uploadIntentIds: z.array(z.uuid()).min(1).max(MAX_LOTE_FILES),
  marketplace: z.enum(["mercado-livre"]),
  size: outputSizeSchema,
  numbering: labelNumberingSchema.optional(),
}).strict();

export type CreateMarketplaceLoteInput = z.infer<typeof createMarketplaceLoteInputSchema>;
export type AcceptedLote = { id: string; status: "queued"; progress: 0; itemCount: number; createdAt: string };

/** One order already split out of an uploaded file and snapshotted to its own
 * object. Carries the name of the file it came from, for the conversion record. */
type OrderSnapshot = { objectKey: string; sha256: string; byteLength: number; originalFileName: string | undefined };

type CommitInput = {
  actor: Pick<Actor, "organizationId" | "userId">;
  request: CreateMarketplaceLoteInput;
  intents: UploadIntentRecord[];
  sourceByteLengths: number[];
  orders: OrderSnapshot[];
  batchId: string;
  now(): Date;
  randomId(): string;
};

export type MarketplaceCreationDependencies = {
  storage: StorageGateway;
  loadIntent(organizationId: string, intentId: string): Promise<UploadIntentRecord>;
  readUpload(intent: UploadIntentRecord, storage: StorageGateway): Promise<ReadValidatedUpload>;
  commit(input: CommitInput): Promise<{ createdAt: Date; outboxIds: string[] }>;
  publish(eventId: string): Promise<void>;
  randomId(): string;
  now(): Date;
};

async function consumedConflict(organizationId: string, uploadIntentId: string): Promise<never> {
  throw new AppError("upload_already_consumed", "Este upload já foi utilizado.", 409, { uploadIntentId });
}

/**
 * Commits a marketplace lote: one `batches` row (kind='marketplace') plus one
 * `conversions` row per order, each reserving one quota unit, mirroring
 * `commitBatch`. The orders were already split and snapshotted by the caller.
 */
export async function commitMarketplaceLote(
  input: CommitInput,
  database: UnoDatabase = getDb(),
): Promise<{ createdAt: Date; outboxIds: string[] }> {
  return database.transaction(async (transaction) => {
    const lockedIntents: UploadIntentRecord[] = [];
    for (const requested of input.intents) {
      const locked = await transaction.select().from(uploadIntents)
        .where(and(eq(uploadIntents.organizationId, input.actor.organizationId), eq(uploadIntents.id, requested.id)))
        .limit(1).for("update");
      const intent = locked[0];
      if (!intent) throw new AppError("upload_not_found", "Upload não encontrado.", 404);
      if (intent.consumedAt) return consumedConflict(input.actor.organizationId, intent.id);
      lockedIntents.push(intent);
    }

    if (process.env.NODE_ENV !== "production" && process.env.UNO_ALLOW_DRAFT_TEMPLATES === "true") {
      await seedInitialDraftTemplate(transaction);
    }
    const template = await findTemplate(INITIAL_TEMPLATE, transaction);
    assertTemplateEligible(template, input.request.size);

    const subscriptionRows = await transaction.select({ ...subscriptionEntitlementColumns })
      .from(subscriptions).where(eq(subscriptions.organizationId, input.actor.organizationId)).limit(1).for("update");
    const decisionNow = input.now();
    if (lockedIntents.some((locked) => locked.expiresAt <= decisionNow)) throw new AppError("upload_expired", "Este upload expirou.", 410);
    const entitlement = effectivePlanFromSubscription(subscriptionRows[0], decisionNow);
    if (input.sourceByteLengths.some((length) => length > entitlement.plan.maxFileMB * 1_024 * 1_024)) {
      throw new AppError("file_too_large", "Um dos arquivos excede o limite permitido pelo plano atual.", 413);
    }
    if (input.orders.length > entitlement.plan.batchLimit) {
      throw new AppError("batch_limit_exceeded", "O lote excede o limite de pedidos do plano atual.", 413);
    }
    const usagePeriod = await lockCurrentUsagePeriod(input.actor.organizationId, entitlement, decisionNow, transaction);
    assertUsageAvailable(usagePeriod, entitlement.plan.monthlyLimit, input.orders.length);

    const dimensions = sizeDimensions(input.request.size);
    const artifactsExpireAt = new Date(decisionNow.getTime() + entitlement.plan.retentionDays * 86_400_000);
    await transaction.insert(batches).values({
      id: input.batchId,
      organizationId: input.actor.organizationId,
      createdByUserId: input.actor.userId,
      status: "queued",
      phase: "queued",
      kind: "marketplace",
      marketplace: input.request.marketplace,
      numbering: input.request.numbering ?? null,
      itemCount: input.orders.length,
      progress: 0,
      artifactsExpireAt,
      createdAt: decisionNow,
      updatedAt: decisionNow,
    });

    const outboxIds: string[] = [];
    try {
      for (const [index, order] of input.orders.entries()) {
        const conversionId = input.randomId();
        const outboxId = input.randomId();
        await transaction.insert(conversions).values({
          id: conversionId,
          organizationId: input.actor.organizationId,
          createdByUserId: input.actor.userId,
          batchId: input.batchId,
          batchOrderIndex: index,
          templateId: template.id,
          templateVersion: template.version,
          engineVersion: template.engineVersion,
          status: "queued",
          source: "dashboard",
          originalFileName: order.originalFileName,
          progress: 0,
          currentStage: "queued",
          outputPreset: input.request.size.preset,
          outputWidthMm: String(dimensions.widthMm),
          outputHeightMm: String(dimensions.heightMm),
          inputObjectKey: order.objectKey,
          inputSha256: order.sha256,
          sourceByteLength: order.byteLength,
          artifactsExpireAt,
          queuedAt: decisionNow,
          createdAt: decisionNow,
          updatedAt: decisionNow,
        });
        await reserveUsage({
          reservationId: input.randomId(),
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

    for (const locked of lockedIntents) {
      const consumed = await transaction.update(uploadIntents).set({ consumedAt: decisionNow })
        .where(and(eq(uploadIntents.id, locked.id), eq(uploadIntents.organizationId, input.actor.organizationId), isNull(uploadIntents.consumedAt)))
        .returning({ id: uploadIntents.id });
      if (consumed.length !== 1) return consumedConflict(input.actor.organizationId, locked.id);
    }

    return { createdAt: decisionNow, outboxIds };
  });
}

function defaultDependencies(): MarketplaceCreationDependencies {
  const storage = getStorage();
  return {
    storage,
    randomId: randomUUID,
    now: () => new Date(),
    loadIntent: findUploadIntentForOrganization,
    readUpload: (intent, gateway) => readValidatedUpload(intent, { storage: gateway }),
    commit: (input) => commitMarketplaceLote(input),
    async publish(eventId) {
      await publishPendingConversionJobs({ eventId, limit: 1 });
    },
  };
}

/**
 * Splits the uploaded marketplace file into per-order PDFs, snapshots each to
 * its own immutable object, and commits a lote of one conversion per order. The
 * existing conversion worker then processes each order; a later combine step
 * (see ./combine) assembles the single output PDF. Quota is reserved per order.
 */
export async function createMarketplaceLote(
  actor: Pick<Actor, "organizationId" | "userId">,
  rawInput: unknown,
  dependencies: MarketplaceCreationDependencies = defaultDependencies(),
): Promise<AcceptedLote> {
  const request = createMarketplaceLoteInputSchema.parse(rawInput);
  if (new Set(request.uploadIntentIds).size !== request.uploadIntentIds.length) {
    throw new AppError("invalid_request", "Um arquivo foi enviado mais de uma vez.", 400);
  }
  const pagesPerOrder = MARKETPLACE_PAGES_PER_ORDER[request.marketplace];

  const intents: UploadIntentRecord[] = [];
  const sourceByteLengths: number[] = [];
  const orders: OrderSnapshot[] = [];
  // Files are read in the order the caller sent them, and each is split into its
  // orders in page sequence, so the combined output follows the chosen order.
  for (const intentId of request.uploadIntentIds) {
    const intent = await dependencies.loadIntent(actor.organizationId, intentId);
    const source = await dependencies.readUpload(intent, dependencies.storage);
    intents.push(intent);
    sourceByteLengths.push(source.contentLength);

    const orderPdfs = await splitIntoOrderPdfs(source.bytes, pagesPerOrder);
    for (const bytes of orderPdfs) {
      const objectKey = `organizations/${actor.organizationId}/conversion-inputs/${dependencies.randomId()}.pdf`;
      await dependencies.storage.putBytes(objectKey, Buffer.from(bytes), "application/pdf", bytes.length);
      orders.push({ objectKey, sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length, originalFileName: source.originalFileName });
    }
  }

  const batchId = dependencies.randomId();
  const commitInput: CommitInput = {
    actor,
    request,
    intents,
    sourceByteLengths,
    orders,
    batchId,
    now: dependencies.now,
    randomId: dependencies.randomId,
  };

  let committed: { createdAt: Date; outboxIds: string[] };
  try {
    committed = await dependencies.commit(commitInput);
  } catch (error) {
    // The commit is atomic, so a failure consumed no quota and did not mark the
    // intent used. The order snapshots are now orphaned; best-effort cleanup,
    // and the retention collector removes any that remain.
    await Promise.all(orders.map((order) => dependencies.storage.delete(order.objectKey).catch(() => undefined)));
    throw error;
  }

  for (const outboxId of committed.outboxIds) await dependencies.publish(outboxId).catch(() => undefined);
  return { id: batchId, status: "queued", progress: 0, itemCount: orders.length, createdAt: committed.createdAt.toISOString() };
}

export type { CommitInput as MarketplaceCommitInput, OrderSnapshot };
