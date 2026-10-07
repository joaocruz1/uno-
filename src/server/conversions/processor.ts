import { createHash, randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import {
  conversionPages,
  conversions,
  getDb,
  outboxEvents,
  processingEvents,
  templates,
  usageReservations,
  type UnoDatabase,
} from "@/db";
import { confirmUsage, releaseUsage } from "@/db/usage";
import { EngineError } from "@/engine/errors";
import { convertPdfIsolated } from "@/engine/isolated";
import { findTemplateDefinition } from "@/engine/templates";
import {
  ENGINE_VERSION,
  type ConversionResult,
  type OutputSize,
  type ProgressEvent,
} from "@/engine/types";
import { outputSizeSchema } from "@/lib/label-size";
import type { ProductHeader } from "@/lib/product-header";
import { getStorage, type StorageGateway } from "@/server/storage";

import { assertTemplateEligible, type TemplateEligibility } from "./templates";

const LEASE_MS = 60_000;
const RENEW_MS = 20_000;
const MAX_OUTPUT_BYTES = 150 * 1_024 * 1_024;

export type ClaimRow = {
  id: string;
  organizationId: string;
  inputObjectKey: string;
  inputSha256: string;
  sourceByteLength: number;
  outputPreset: string;
  outputWidthMm: string;
  outputHeightMm: string;
  productHeader?: ProductHeader | null;
  templateKey: string;
  templateVersion: string;
  engineVersion: string;
  templateStatus: TemplateEligibility["status"];
  templateDefinition: TemplateEligibility["definition"];
  templateReleasedAt: Date | null;
  attempts: number;
  maxAttempts: number;
  token: string;
};

class ProcessingContractError extends Error {
  readonly terminal = true;

  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ProcessingContractError";
  }
}

export type ProcessorDependencies = {
  database: UnoDatabase;
  storage: StorageGateway;
  convert(
    bytes: Uint8Array,
    size: OutputSize,
    template: string,
    onProgress: (event: ProgressEvent) => Promise<void>,
    options?: { product?: ProductHeader },
  ): Promise<ConversionResult>;
  randomId(): string;
  now(): Date;
};

function defaults(): ProcessorDependencies {
  return {
    database: getDb(),
    storage: getStorage(),
    convert: convertPdfIsolated,
    randomId: randomUUID,
    now: () => new Date(),
  };
}

function outputSize(claim: ClaimRow): OutputSize {
  if (claim.outputPreset === "custom") {
    return outputSizeSchema.parse({
      preset: "custom",
      widthMm: Number(claim.outputWidthMm),
      heightMm: Number(claim.outputHeightMm),
    });
  }
  return outputSizeSchema.parse({ preset: claim.outputPreset });
}

export async function claimConversion(conversionId: string, token: string, dependencies: ProcessorDependencies): Promise<ClaimRow | undefined> {
  const lease = new Date(dependencies.now().getTime() + LEASE_MS);
  return dependencies.database.transaction(async (transaction) => {
    const rows = await transaction.select({
      id: conversions.id,
      organizationId: conversions.organizationId,
      inputObjectKey: conversions.inputObjectKey,
      inputSha256: conversions.inputSha256,
      sourceByteLength: conversions.sourceByteLength,
      outputPreset: conversions.outputPreset,
      outputWidthMm: conversions.outputWidthMm,
      outputHeightMm: conversions.outputHeightMm,
      productHeader: conversions.productHeader,
      templateKey: templates.key,
      templateVersion: conversions.templateVersion,
      engineVersion: conversions.engineVersion,
      templateStatus: templates.status,
      templateDefinition: templates.definition,
      templateReleasedAt: templates.releasedAt,
      attempts: conversions.attempts,
      maxAttempts: conversions.maxAttempts,
    }).from(conversions).innerJoin(templates, eq(templates.id, conversions.templateId))
      .where(and(
        eq(conversions.id, conversionId),
        sql`(${conversions.status} = 'queued' or (${conversions.status} = 'processing' and ${conversions.processingLeaseExpiresAt} < now()))`,
      ))
      .limit(1).for("update");
    const row = rows[0];
    if (!row || !row.inputSha256 || row.attempts >= row.maxAttempts) return undefined;
    const attempt = row.attempts + 1;
    const updated = await transaction.update(conversions).set({
      status: "processing",
      attempts: attempt,
      processingToken: token,
      processingLeaseExpiresAt: lease,
      processingStartedAt: sql`coalesce(${conversions.processingStartedAt}, now())`,
      currentStage: "processing",
      updatedAt: dependencies.now(),
    }).where(eq(conversions.id, conversionId)).returning({ id: conversions.id });
    if (updated.length !== 1) return undefined;
    await transaction.insert(processingEvents).values({
      organizationId: row.organizationId,
      conversionId,
      stage: "processing",
      progress: 0,
      attempt,
      metadata: {},
    });
    return { ...row, inputSha256: row.inputSha256, attempts: attempt, token };
  });
}

async function persistProgress(claim: ClaimRow, event: ProgressEvent, dependencies: ProcessorDependencies): Promise<void> {
  await dependencies.database.transaction(async (transaction) => {
    const updated = await transaction.update(conversions).set({
      progress: event.progress,
      currentStage: event.stage,
      processingLeaseExpiresAt: new Date(dependencies.now().getTime() + LEASE_MS),
      updatedAt: dependencies.now(),
    }).where(and(
      eq(conversions.id, claim.id),
      eq(conversions.organizationId, claim.organizationId),
      eq(conversions.status, "processing"),
      eq(conversions.processingToken, claim.token),
    )).returning({ id: conversions.id });
    if (updated.length !== 1) throw new Error("conversion_claim_lost");
    await transaction.insert(processingEvents).values({
      organizationId: claim.organizationId,
      conversionId: claim.id,
      stage: event.stage,
      progress: event.progress,
      attempt: claim.attempts,
      metadata: {},
    });
  });
}

async function renewLease(claim: ClaimRow, dependencies: ProcessorDependencies): Promise<boolean> {
  const updated = await dependencies.database.update(conversions).set({
    processingLeaseExpiresAt: new Date(dependencies.now().getTime() + LEASE_MS),
    updatedAt: dependencies.now(),
  }).where(and(
    eq(conversions.id, claim.id),
    eq(conversions.status, "processing"),
    eq(conversions.processingToken, claim.token),
  )).returning({ id: conversions.id });
  return updated.length === 1;
}

async function stillOwnsClaim(claim: ClaimRow, dependencies: ProcessorDependencies): Promise<boolean> {
  const rows = await dependencies.database.select({ id: conversions.id }).from(conversions).where(and(
    eq(conversions.id, claim.id),
    eq(conversions.status, "processing"),
    eq(conversions.processingToken, claim.token),
  )).limit(1);
  return rows.length === 1;
}

async function reservationFor(claim: ClaimRow, database: Pick<UnoDatabase, "select">) {
  const rows = await database.select({ id: usageReservations.id }).from(usageReservations)
    .where(and(eq(usageReservations.organizationId, claim.organizationId), eq(usageReservations.conversionId, claim.id))).limit(1);
  return rows[0];
}

async function completeConversion(
  claim: ClaimRow,
  result: ConversionResult,
  outputKey: string,
  dependencies: ProcessorDependencies,
): Promise<boolean> {
  return dependencies.database.transaction(async (transaction) => {
    const processingTimeMs = Math.round(Object.values(result.timingsMs).reduce((total, value) => total + value, 0));
    const updated = await transaction.update(conversions).set({
      status: "completed",
      progress: 100,
      currentStage: "completed",
      outputObjectKey: outputKey,
      outputPages: result.pageCount,
      inputPages: result.pages.length,
      processingTimeMs,
      completedAt: dependencies.now(),
      processingToken: null,
      processingLeaseExpiresAt: null,
      errorCode: null,
      errorMessage: null,
      suggestedSize: null,
      updatedAt: dependencies.now(),
    }).where(and(
      eq(conversions.id, claim.id),
      eq(conversions.organizationId, claim.organizationId),
      eq(conversions.status, "processing"),
      eq(conversions.processingToken, claim.token),
    )).returning({ id: conversions.id });
    if (updated.length !== 1) return false;
    await transaction.insert(conversionPages).values(result.pages.map((page) => ({
      organizationId: claim.organizationId,
      conversionId: claim.id,
      pageNumber: page.pageNumber,
      role: page.role,
      kind: page.kind,
      rotationDegrees: page.rotation,
      widthPoints: "283.465",
      heightPoints: "425.197",
    }))).onConflictDoNothing({ target: [conversionPages.conversionId, conversionPages.pageNumber] });
    for (const [stage, duration] of Object.entries(result.timingsMs)) {
      await transaction.update(processingEvents).set({ durationMs: Math.round(duration) }).where(and(
        eq(processingEvents.organizationId, claim.organizationId),
        eq(processingEvents.conversionId, claim.id),
        eq(processingEvents.attempt, claim.attempts),
        eq(processingEvents.stage, stage),
      ));
    }
    await transaction.insert(processingEvents).values({
      organizationId: claim.organizationId,
      conversionId: claim.id,
      stage: "completed",
      progress: 100,
      attempt: claim.attempts,
      durationMs: processingTimeMs,
      metadata: {},
    });
    const reservation = await reservationFor(claim, transaction);
    if (!reservation) throw new Error("usage_reservation_not_found");
    await confirmUsage(reservation.id, claim.organizationId, transaction);
    await transaction.insert(outboxEvents).values({
      id: dependencies.randomId(),
      organizationId: claim.organizationId,
      type: "conversion.completed",
      aggregateType: "conversion",
      aggregateId: claim.id,
      deduplicationKey: `conversion.completed.${claim.id}`,
      payload: { conversionId: claim.id },
    }).onConflictDoNothing({ target: outboxEvents.deduplicationKey });
    return true;
  });
}

type SafeFailure = { code: string; message: string; terminal: boolean; suggestedSize?: OutputSize };

export function assertProcessingClaimSupported(claim: ClaimRow): void {
  if (claim.engineVersion !== ENGINE_VERSION) {
    throw new ProcessingContractError(
      "unsupported_engine_version",
      "A versão do processador desta conversão não está disponível.",
    );
  }
  if (!findTemplateDefinition(claim.templateKey, claim.templateVersion)) {
    throw new ProcessingContractError(
      "unsupported_template_version",
      "A versão do modelo desta conversão não está disponível.",
    );
  }
  try {
    assertTemplateEligible({
      engineVersion: claim.engineVersion,
      status: claim.templateStatus,
      definition: claim.templateDefinition,
      releasedAt: claim.templateReleasedAt,
    }, outputSize(claim));
  } catch {
    throw new ProcessingContractError(
      "template_not_released",
      "O modelo e o formato desta conversão não estão disponíveis.",
    );
  }
}

export function assertEngineResultMatchesClaim(claim: ClaimRow, result: ConversionResult): void {
  if (
    result.versions.engine !== claim.engineVersion ||
    result.versions.templateKey !== claim.templateKey ||
    result.versions.template !== claim.templateVersion
  ) {
    throw new ProcessingContractError(
      "processing_version_mismatch",
      "A versão do resultado não corresponde à conversão solicitada.",
    );
  }
}

function safeFailure(error: unknown): SafeFailure {
  if (error instanceof ProcessingContractError) {
    return { code: error.code, message: error.message, terminal: true };
  }
  if (error instanceof EngineError) {
    return { code: error.code, message: error.message, terminal: error.terminal, suggestedSize: error.suggestedSize };
  }
  return { code: "processing_unavailable", message: "O processamento falhou temporariamente.", terminal: false };
}

async function failOrRetry(
  claim: ClaimRow,
  failure: SafeFailure,
  dependencies: ProcessorDependencies,
  options: { requireExpiredLease?: boolean } = {},
): Promise<"failed" | "retry" | "stale"> {
  const terminal = failure.terminal || claim.attempts >= claim.maxAttempts;
  return dependencies.database.transaction(async (transaction) => {
    const ownershipConditions = [
      eq(conversions.id, claim.id),
      eq(conversions.status, "processing"),
      eq(conversions.processingToken, claim.token),
    ];
    if (options.requireExpiredLease) {
      ownershipConditions.push(sql`${conversions.processingLeaseExpiresAt} < now()`);
    }
    const updated = await transaction.update(conversions).set({
      status: terminal ? "failed" : "queued",
      currentStage: terminal ? "failed" : "retrying",
      errorCode: terminal ? failure.code : null,
      errorMessage: terminal ? failure.message : null,
      suggestedSize: terminal && failure.suggestedSize ? JSON.stringify(failure.suggestedSize) : null,
      processingToken: null,
      processingLeaseExpiresAt: null,
      updatedAt: dependencies.now(),
    }).where(and(...ownershipConditions)).returning({ id: conversions.id });
    if (updated.length !== 1) return "stale" as const;
    await transaction.insert(processingEvents).values({
      organizationId: claim.organizationId,
      conversionId: claim.id,
      stage: terminal ? "failed" : "retrying",
      progress: 0,
      attempt: claim.attempts,
      metadata: { code: failure.code },
    });
    if (!terminal) {
      await transaction.insert(outboxEvents).values({
        id: dependencies.randomId(),
        organizationId: claim.organizationId,
        type: "conversion.queued",
        aggregateType: "conversion",
        aggregateId: claim.id,
        deduplicationKey: `conversion.retry.${claim.id}.${claim.attempts}`,
        payload: { conversionId: claim.id },
        availableAt: new Date(dependencies.now().getTime() + Math.min(30_000, 2_000 * 2 ** (claim.attempts - 1))),
      }).onConflictDoNothing({ target: outboxEvents.deduplicationKey });
      return "retry" as const;
    }
    const reservation = await reservationFor(claim, transaction);
    if (reservation) await releaseUsage(reservation.id, claim.organizationId, transaction);
    await transaction.insert(outboxEvents).values({
      id: dependencies.randomId(),
      organizationId: claim.organizationId,
      type: "conversion.failed",
      aggregateType: "conversion",
      aggregateId: claim.id,
      deduplicationKey: `conversion.failed.${claim.id}`,
      payload: { conversionId: claim.id, errorCode: failure.code },
    }).onConflictDoNothing({ target: outboxEvents.deduplicationKey });
    return "failed" as const;
  });
}

export async function reconcileExhaustedConversion(conversionId: string, dependencies: ProcessorDependencies = defaults()): Promise<void> {
  const rows = await dependencies.database.select().from(conversions)
    .where(and(
      eq(conversions.id, conversionId),
      eq(conversions.status, "processing"),
      sql`${conversions.attempts} >= ${conversions.maxAttempts}`,
      sql`${conversions.processingLeaseExpiresAt} < now()`,
    ))
    .limit(1);
  const row = rows[0];
  if (!row || !row.processingToken) return;
  const template = await dependencies.database.select({
    key: templates.key,
    status: templates.status,
    definition: templates.definition,
    releasedAt: templates.releasedAt,
  }).from(templates).where(eq(templates.id, row.templateId)).limit(1);
  await failOrRetry({
    id: row.id,
    organizationId: row.organizationId,
    inputObjectKey: row.inputObjectKey,
    inputSha256: row.inputSha256 ?? "",
    sourceByteLength: row.sourceByteLength,
    outputPreset: row.outputPreset,
    outputWidthMm: row.outputWidthMm,
    outputHeightMm: row.outputHeightMm,
    templateKey: template[0]?.key ?? "mercado-livre",
    templateVersion: row.templateVersion,
    engineVersion: row.engineVersion,
    templateStatus: template[0]?.status ?? "RETIRED",
    templateDefinition: template[0]?.definition ?? {},
    templateReleasedAt: template[0]?.releasedAt ?? null,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    token: row.processingToken,
  }, { code: "processing_unavailable", message: "Não foi possível concluir o processamento.", terminal: true }, dependencies, {
    requireExpiredLease: true,
  });
}

async function reconcileAttemptOutput(
  claim: ClaimRow,
  outputKey: string,
  dependencies: ProcessorDependencies,
): Promise<"committed" | "orphan"> {
  return dependencies.database.transaction(async (transaction) => {
    const rows = await transaction.select({
      status: conversions.status,
      outputObjectKey: conversions.outputObjectKey,
    }).from(conversions).where(and(
      eq(conversions.id, claim.id),
      eq(conversions.organizationId, claim.organizationId),
    )).limit(1).for("update");
    const row = rows[0];
    return row?.status === "completed" && row.outputObjectKey === outputKey ? "committed" : "orphan";
  });
}

export async function recoverQueuedConversion(
  conversionId: string,
  recoveryKey: string,
  dependencies: ProcessorDependencies = defaults(),
): Promise<boolean> {
  return dependencies.database.transaction(async (transaction) => {
    const rows = await transaction.select({
      id: conversions.id,
      organizationId: conversions.organizationId,
      status: conversions.status,
    }).from(conversions).where(eq(conversions.id, conversionId)).limit(1).for("update");
    const row = rows[0];
    if (!row || row.status !== "queued") return false;
    await transaction.insert(outboxEvents).values({
      id: dependencies.randomId(),
      organizationId: row.organizationId,
      type: "conversion.queued",
      aggregateType: "conversion",
      aggregateId: row.id,
      deduplicationKey: `conversion.queue-recovery.${row.id}.${recoveryKey.replace(/[^A-Za-z0-9_-]/g, "-")}`,
      payload: { conversionId: row.id },
      availableAt: new Date(dependencies.now().getTime() + 5_000),
    }).onConflictDoNothing({ target: outboxEvents.deduplicationKey });
    return true;
  });
}

export async function recoverOrphanedQueuedConversions(dependencies: ProcessorDependencies = defaults()): Promise<number> {
  const now = dependencies.now();
  const bucket = Math.floor(now.getTime() / 60_000);
  const rows = await dependencies.database.select({ id: conversions.id }).from(conversions)
    .where(and(eq(conversions.status, "queued"), sql`${conversions.updatedAt} < now() - interval '30 seconds'`))
    .limit(50);
  let recovered = 0;
  for (const row of rows) {
    if (await recoverQueuedConversion(row.id, `orphan-${bucket}`, dependencies)) recovered += 1;
  }
  return recovered;
}

export async function reconcileExpiredConversionClaims(dependencies: ProcessorDependencies = defaults()): Promise<number> {
  const expired = await dependencies.database.select({ id: conversions.id }).from(conversions)
    .where(and(eq(conversions.status, "processing"), sql`${conversions.processingLeaseExpiresAt} < now()`))
    .limit(50);
  let recovered = 0;
  for (const candidate of expired) {
    const action = await dependencies.database.transaction(async (transaction) => {
      const rows = await transaction.select().from(conversions).where(eq(conversions.id, candidate.id)).limit(1).for("update");
      const row = rows[0];
      if (!row || row.status !== "processing" || !row.processingToken || !row.processingLeaseExpiresAt || row.processingLeaseExpiresAt >= dependencies.now()) {
        return "none" as const;
      }
      if (row.attempts >= row.maxAttempts) {
        await transaction.update(conversions).set({
          processingToken: dependencies.randomId(),
          processingLeaseExpiresAt: new Date(dependencies.now().getTime() - 1),
          updatedAt: dependencies.now(),
        }).where(and(eq(conversions.id, row.id), eq(conversions.processingToken, row.processingToken)));
        return "exhausted" as const;
      }
      await transaction.update(conversions).set({
        status: "queued",
        currentStage: "recovered",
        processingToken: null,
        processingLeaseExpiresAt: null,
        updatedAt: dependencies.now(),
      }).where(and(eq(conversions.id, row.id), eq(conversions.processingToken, row.processingToken)));
      await transaction.insert(outboxEvents).values({
        id: dependencies.randomId(),
        organizationId: row.organizationId,
        type: "conversion.queued",
        aggregateType: "conversion",
        aggregateId: row.id,
        deduplicationKey: `conversion.recovered.${row.id}.${row.attempts}`,
        payload: { conversionId: row.id },
      }).onConflictDoNothing({ target: outboxEvents.deduplicationKey });
      return "recovered" as const;
    });
    if (action === "exhausted") await reconcileExhaustedConversion(candidate.id, dependencies);
    if (action !== "none") recovered += 1;
  }
  return recovered;
}

export async function processConversion(conversionId: string, dependencies: ProcessorDependencies = defaults()): Promise<void> {
  const claim = await claimConversion(conversionId, dependencies.randomId(), dependencies);
  if (!claim) {
    await reconcileExhaustedConversion(conversionId, dependencies);
    return;
  }
  let claimLost = false;
  const renewal = setInterval(() => {
    void renewLease(claim, dependencies).then((owned) => { if (!owned) claimLost = true; }, () => { claimLost = true; });
  }, RENEW_MS);
  renewal.unref();
  let attemptOutputKey: string | undefined;
  try {
    assertProcessingClaimSupported(claim);
    const input = await dependencies.storage.read(claim.inputObjectKey, claim.sourceByteLength);
    if (input.length !== claim.sourceByteLength || createHash("sha256").update(input).digest("hex") !== claim.inputSha256) {
      const disposition = await failOrRetry(claim, {
        code: "input_integrity_failed",
        message: "A integridade do arquivo de entrada não pôde ser confirmada.",
        terminal: true,
      }, dependencies);
      if (disposition === "retry") throw new Error("retry_conversion");
      return;
    }
    const result = await dependencies.convert(
      input,
      outputSize(claim),
      `${claim.templateKey}@${claim.templateVersion}`,
      async (event) => {
        if (claimLost) throw new Error("conversion_claim_lost");
        await persistProgress(claim, event, dependencies);
      },
      claim.productHeader ? { product: claim.productHeader } : {},
    );
    assertEngineResultMatchesClaim(claim, result);
    if (claimLost || !await stillOwnsClaim(claim, dependencies)) return;
    attemptOutputKey = `organizations/${claim.organizationId}/conversion-outputs/${claim.id}/${claim.token}.pdf`;
    const output = Buffer.from(result.bytes);
    await dependencies.storage.putBytes(attemptOutputKey, output, "application/pdf", MAX_OUTPUT_BYTES);
    try {
      const completed = await completeConversion(claim, result, attemptOutputKey, dependencies);
      if (!completed) await dependencies.storage.delete(attemptOutputKey).catch(() => undefined);
    } catch (error) {
      try {
        const disposition = await reconcileAttemptOutput(claim, attemptOutputKey, dependencies);
        if (disposition === "orphan") await dependencies.storage.delete(attemptOutputKey).catch(() => undefined);
      } catch {
        // A failed reconciliation can hide a committed completion. Preserve the
        // attempt object until a later collector can prove it is unreferenced.
      }
      throw error;
    }
  } catch (error) {
    if (!await stillOwnsClaim(claim, dependencies)) return;
    const disposition = await failOrRetry(claim, safeFailure(error), dependencies);
    if (disposition === "retry") throw error;
  } finally {
    clearInterval(renewal);
  }
}
