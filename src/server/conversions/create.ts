import { randomUUID } from "node:crypto";

import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import {
  conversions,
  getDb,
  outboxEvents,
  subscriptions,
  uploadIntents,
  usagePeriods,
  type UnoDatabase,
} from "@/db";
import { QuotaExceededError, reserveUsage } from "@/db/usage";
import { AppError } from "@/lib/errors";
import { outputSizeSchema, sizeDimensions } from "@/lib/label-size";
import { PLANS, type PlanId } from "@/lib/plans";
import type { Actor } from "@/server/auth/actor";
import { publishPendingConversionJobs } from "@/server/queue/outbox";
import { getStorage, type StorageGateway } from "@/server/storage";
import {
  findUploadIntentForOrganization,
  readValidatedUpload,
  type ReadValidatedUpload,
  type UploadIntentRecord,
} from "@/server/uploads";

import { assertTemplateEligible, findTemplate, INITIAL_TEMPLATE, seedInitialDraftTemplate } from "./templates";

export const createConversionInputSchema = z.object({
  uploadIntentId: z.uuid(),
  template: z.string().max(128).optional(),
  size: outputSizeSchema,
}).strict();

export type CreateConversionInput = z.infer<typeof createConversionInputSchema>;
export type AcceptedConversion = { id: string; status: "queued"; progress: 0; createdAt: string };

type CommitInput = {
  actor: Pick<Actor, "organizationId" | "userId">;
  request: CreateConversionInput;
  intent: UploadIntentRecord;
  upload: ReadValidatedUpload;
  snapshotKey: string;
  conversionId: string;
  reservationId: string;
  outboxId: string;
  now: Date;
};

export type CreationDependencies = {
  storage: StorageGateway;
  loadIntent(organizationId: string, intentId: string): Promise<UploadIntentRecord>;
  readUpload(intent: UploadIntentRecord, storage: StorageGateway): Promise<ReadValidatedUpload>;
  commit(input: CommitInput): Promise<{ createdAt: Date; outboxId: string }>;
  recoverCommitted(input: Pick<CommitInput, "actor" | "intent" | "snapshotKey" | "conversionId">): Promise<{
    createdAt: Date;
    outboxId: string;
  } | null>;
  publish(eventId: string): Promise<void>;
  randomId(): string;
  now(): Date;
};

/**
 * Resolves an indeterminate commit result without risking deletion of a committed input.
 * Locking the upload intent waits for any transaction which consumed it to finish before
 * checking the conversion and its transactional outbox event.
 */
export async function recoverCommittedConversion(
  input: Pick<CommitInput, "actor" | "intent" | "snapshotKey" | "conversionId">,
  database: UnoDatabase = getDb(),
): Promise<{ createdAt: Date; outboxId: string } | null> {
  return database.transaction(async (transaction) => {
    await transaction.select({ id: uploadIntents.id }).from(uploadIntents)
      .where(and(
        eq(uploadIntents.organizationId, input.actor.organizationId),
        eq(uploadIntents.id, input.intent.id),
      ))
      .limit(1)
      .for("update");

    const rows = await transaction.select({
      createdAt: conversions.createdAt,
      inputObjectKey: conversions.inputObjectKey,
    }).from(conversions).where(and(
      eq(conversions.id, input.conversionId),
      eq(conversions.organizationId, input.actor.organizationId),
      eq(conversions.uploadIntentId, input.intent.id),
    )).limit(1);
    const conversion = rows[0];
    if (!conversion) return null;
    if (conversion.inputObjectKey !== input.snapshotKey) {
      throw new Error("conversion_commit_recovery_inconsistent");
    }

    const events = await transaction.select({ id: outboxEvents.id }).from(outboxEvents).where(and(
      eq(outboxEvents.organizationId, input.actor.organizationId),
      eq(outboxEvents.aggregateType, "conversion"),
      eq(outboxEvents.aggregateId, input.conversionId),
      eq(outboxEvents.type, "conversion.queued"),
    )).limit(1);
    if (!events[0]) throw new Error("conversion_commit_recovery_inconsistent");
    return { createdAt: conversion.createdAt, outboxId: events[0].id };
  });
}

function periodFor(now: Date, subscription?: { currentPeriodStart: Date | null; currentPeriodEnd: Date | null }) {
  if (subscription?.currentPeriodStart && subscription.currentPeriodEnd &&
    subscription.currentPeriodStart <= now && subscription.currentPeriodEnd > now) {
    return { start: subscription.currentPeriodStart, end: subscription.currentPeriodEnd };
  }
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

function retentionDate(now: Date, planId: PlanId): Date {
  return new Date(now.getTime() + PLANS[planId].retentionDays * 86_400_000);
}

async function consumedConflict(
  organizationId: string,
  uploadIntentId: string,
  database: Pick<UnoDatabase, "select">,
): Promise<never> {
  const existing = await database.select({ id: conversions.id }).from(conversions)
    .where(and(eq(conversions.organizationId, organizationId), eq(conversions.uploadIntentId, uploadIntentId))).limit(1);
  throw new AppError(
    "upload_already_consumed",
    "Este upload já foi utilizado.",
    409,
    existing[0] ? { conversionId: existing[0].id } : undefined,
  );
}

export async function commitConversion(input: CommitInput, database: UnoDatabase = getDb()) {
  return database.transaction(async (transaction) => {
    const locked = await transaction.select().from(uploadIntents)
      .where(and(eq(uploadIntents.organizationId, input.actor.organizationId), eq(uploadIntents.id, input.intent.id)))
      .limit(1).for("update");
    const intent = locked[0];
    if (!intent) throw new AppError("upload_not_found", "Upload não encontrado.", 404);
    if (intent.consumedAt) return consumedConflict(input.actor.organizationId, intent.id, transaction);
    if (intent.expiresAt <= input.now) throw new AppError("upload_expired", "Este upload expirou.", 410);

    if (process.env.NODE_ENV !== "production" && process.env.UNO_ALLOW_DRAFT_TEMPLATES === "true") {
      await seedInitialDraftTemplate(transaction);
    }
    const template = await findTemplate(input.request.template ?? INITIAL_TEMPLATE, transaction);
    assertTemplateEligible(template, input.request.size);

    const subscriptionRows = await transaction.select({
      planId: subscriptions.planId,
      currentPeriodStart: subscriptions.currentPeriodStart,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
    }).from(subscriptions).where(eq(subscriptions.organizationId, input.actor.organizationId)).limit(1).for("update");
    const subscription = subscriptionRows[0];
    const planId: PlanId = subscription?.planId ?? "FREE";
    if (input.upload.contentLength > PLANS[planId].maxFileMB * 1_024 * 1_024) {
      throw new AppError("file_too_large", "O arquivo excede o limite permitido pelo plano atual.", 413);
    }
    const period = periodFor(input.now, subscription);
    await transaction.insert(usagePeriods).values({
      organizationId: input.actor.organizationId,
      periodStart: period.start,
      periodEnd: period.end,
      limit: PLANS[planId].monthlyLimit,
    }).onConflictDoNothing({ target: [usagePeriods.organizationId, usagePeriods.periodStart, usagePeriods.periodEnd] });
    const usageRows = await transaction.select({ id: usagePeriods.id }).from(usagePeriods)
      .where(and(
        eq(usagePeriods.organizationId, input.actor.organizationId),
        eq(usagePeriods.periodStart, period.start),
        eq(usagePeriods.periodEnd, period.end),
      )).limit(1).for("update");
    const usagePeriod = usageRows[0];
    if (!usagePeriod) throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);

    const dimensions = sizeDimensions(input.request.size);
    const created = await transaction.insert(conversions).values({
      id: input.conversionId,
      organizationId: input.actor.organizationId,
      createdByUserId: input.actor.userId,
      uploadIntentId: intent.id,
      templateId: template.id,
      templateVersion: template.version,
      engineVersion: template.engineVersion,
      status: "queued",
      source: "dashboard",
      originalFileName: input.upload.originalFileName,
      progress: 0,
      currentStage: "queued",
      outputPreset: input.request.size.preset,
      outputWidthMm: String(dimensions.widthMm),
      outputHeightMm: String(dimensions.heightMm),
      inputObjectKey: input.snapshotKey,
      inputSha256: input.upload.checksumSha256,
      sourceByteLength: input.upload.contentLength,
      artifactsExpireAt: retentionDate(input.now, planId),
      queuedAt: input.now,
      createdAt: input.now,
      updatedAt: input.now,
    }).returning({ createdAt: conversions.createdAt });

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
    const consumed = await transaction.update(uploadIntents).set({ consumedAt: input.now })
      .where(and(eq(uploadIntents.id, intent.id), eq(uploadIntents.organizationId, input.actor.organizationId), isNull(uploadIntents.consumedAt)))
      .returning({ id: uploadIntents.id });
    if (consumed.length !== 1) return consumedConflict(input.actor.organizationId, intent.id, transaction);

    await transaction.insert(outboxEvents).values({
      id: input.outboxId,
      organizationId: input.actor.organizationId,
      type: "conversion.queued",
      aggregateType: "conversion",
      aggregateId: input.conversionId,
      deduplicationKey: `conversion.queued.${input.conversionId}`,
      payload: { conversionId: input.conversionId },
    });
    return { createdAt: created[0]?.createdAt ?? input.now, outboxId: input.outboxId };
  });
}

function defaultDependencies(): CreationDependencies {
  const storage = getStorage();
  return {
    storage,
    randomId: randomUUID,
    now: () => new Date(),
    loadIntent: findUploadIntentForOrganization,
    readUpload: (intent, gateway) => readValidatedUpload(intent, { storage: gateway }),
    commit: (input) => commitConversion(input),
    recoverCommitted: (input) => recoverCommittedConversion(input),
    async publish(eventId) {
      await publishPendingConversionJobs({ eventId, limit: 1 });
    },
  };
}

export async function createConversionFromUpload(
  actor: Pick<Actor, "organizationId" | "userId">,
  rawInput: unknown,
  dependencies: CreationDependencies = defaultDependencies(),
): Promise<AcceptedConversion> {
  const request = createConversionInputSchema.parse(rawInput);
  const intent = await dependencies.loadIntent(actor.organizationId, request.uploadIntentId);
  const upload = await dependencies.readUpload(intent, dependencies.storage);
  const conversionId = dependencies.randomId();
  const snapshotId = dependencies.randomId();
  const snapshotKey = `organizations/${actor.organizationId}/conversion-inputs/${snapshotId}.pdf`;
  await dependencies.storage.putBytes(snapshotKey, upload.bytes, "application/pdf", upload.contentLength);

  let committed: { createdAt: Date; outboxId: string };
  const commitInput: CommitInput = {
      actor,
      request,
      intent,
      upload,
      snapshotKey,
      conversionId,
      reservationId: dependencies.randomId(),
      outboxId: dependencies.randomId(),
      now: dependencies.now(),
  };
  try {
    committed = await dependencies.commit(commitInput);
  } catch (error) {
    let recovered: { createdAt: Date; outboxId: string } | null;
    try {
      recovered = await dependencies.recoverCommitted(commitInput);
    } catch {
      // An unknown database result can include a committed transaction. The immutable
      // snapshot must remain available; a later orphan collector can prove and remove it.
      throw error;
    }
    if (!recovered) {
      await dependencies.storage.delete(snapshotKey).catch(() => undefined);
      throw error;
    }
    committed = recovered;
  }

  await dependencies.publish(committed.outboxId).catch(() => undefined);
  return { id: conversionId, status: "queued", progress: 0, createdAt: committed.createdAt.toISOString() };
}

export type { CommitInput };
