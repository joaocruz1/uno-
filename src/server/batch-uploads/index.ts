import { createHash, randomUUID } from "node:crypto";

import { and, count, eq, inArray, sql, sum } from "drizzle-orm";
import { z } from "zod";

import {
  batchUploadItems,
  batchUploadSessions,
  getDb,
  type UnoDatabase,
} from "@/db";
import { AppError } from "@/lib/errors";
import { positiveIntegerEnv } from "@/lib/env";
import { batchUploadSessionSchema, type BatchUploadResponse, type BatchUploadSession } from "@/lib/batch-model";
import { outputSizeSchema, sizeDimensions } from "@/lib/label-size";
import { PLANS } from "@/lib/plans";
import type { Actor } from "@/server/auth/actor";
import { enforceRateLimit } from "@/server/rate-limit";
import { getStorage, type StorageGateway } from "@/server/storage";
import { assertTemplateEligible, findTemplate, INITIAL_TEMPLATE, seedInitialDraftTemplate } from "@/server/conversions/templates";

const DEFAULT_SESSION_TTL_SECONDS = 24 * 60 * 60;
const SIGNED_UPLOAD_SECONDS = 300;
const SYNC_FINALIZE_MAX_BYTES = 20 * 1_024 * 1_024;
const MAX_MANIFEST_ITEMS = PLANS.BUSINESS.batchLimit;

const safeName = z.string().trim().min(1).max(160).refine((value) => !/[\x00-\x1f\x7f/\\]/u.test(value));
const manifestItemSchema = z.object({
  clientItemId: z.uuid(),
  originalFileName: safeName,
  contentLength: z.number().int().positive(),
  checksumSha256: z.string().regex(/^[0-9a-fA-F]{64}$/).transform((value) => value.toLowerCase()).optional(),
}).strict();
export const createBatchUploadSchema = z.object({
  items: z.array(manifestItemSchema).min(1).max(MAX_MANIFEST_ITEMS),
  size: outputSizeSchema,
  template: z.string().max(128).optional(),
}).strict().refine((value) => new Set(value.items.map((item) => item.clientItemId)).size === value.items.length, {
  message: "clientItemId duplicado",
  path: ["items"],
});

type BatchUploadDependencies = {
  database: UnoDatabase;
  storage: StorageGateway;
  randomId(): string;
  now(): Date;
  rateLimit(actor: Pick<Actor, "organizationId" | "planId">): Promise<void>;
};

function defaults(): BatchUploadDependencies {
  return {
    database: getDb(),
    storage: getStorage(),
    randomId: randomUUID,
    now: () => new Date(),
    rateLimit: async (actor) => enforceRateLimit({
      namespace: "dashboard-batch-upload",
      identifier: actor.organizationId,
      limit: PLANS[actor.planId].rateLimit || 30,
    }),
  };
}

function publicSessionStatus(status: "OPEN" | "ACCEPTED" | "EXPIRED", expiresAt: Date, now: Date) {
  if (status === "OPEN" && expiresAt <= now) return "expired" as const;
  return status.toLowerCase() as "open" | "accepted" | "expired";
}

function publicItemStatus(status: "PENDING" | "UPLOADING" | "PREPARING" | "READY" | "FAILED") {
  return status.toLowerCase() as "pending" | "uploading" | "preparing" | "ready" | "failed";
}

export async function readBatchUploadSession(
  organizationId: string,
  sessionId: string,
  dependencies: Pick<BatchUploadDependencies, "database" | "now"> = defaults(),
): Promise<BatchUploadSession> {
  const sessions = await dependencies.database.select().from(batchUploadSessions).where(and(
    eq(batchUploadSessions.organizationId, organizationId),
    eq(batchUploadSessions.id, sessionId),
  )).limit(1);
  const session = sessions[0];
  if (!session) throw new AppError("not_found", "Sessão de lote não encontrada.", 404);
  const items = await dependencies.database.select().from(batchUploadItems).where(and(
    eq(batchUploadItems.organizationId, organizationId),
    eq(batchUploadItems.sessionId, sessionId),
  )).orderBy(batchUploadItems.createdAt, batchUploadItems.id);
  return batchUploadSessionSchema.parse({
    id: session.id,
    status: publicSessionStatus(session.status, session.expiresAt, dependencies.now()),
    template: session.templateReference,
    size: session.outputPreset === "custom"
      ? { preset: "custom", widthMm: Number(session.outputWidthMm), heightMm: Number(session.outputHeightMm) }
      : { preset: session.outputPreset },
    expiresAt: session.expiresAt.toISOString(),
    items: items.map((item) => ({
      id: item.id,
      clientItemId: item.clientItemId,
      originalFileName: item.originalFileName,
      contentLength: item.contentLength,
      status: publicItemStatus(item.status),
      ...(item.errorCode && item.errorMessage ? { error: { code: item.errorCode, message: item.errorMessage } } : {}),
    })),
  });
}

export async function createBatchUploadSession(
  actor: Pick<Actor, "organizationId" | "userId" | "planId">,
  rawInput: unknown,
  dependencies: BatchUploadDependencies = defaults(),
): Promise<BatchUploadSession> {
  const input = createBatchUploadSchema.parse(rawInput);
  const plan = PLANS[actor.planId];
  if (input.items.length > plan.batchLimit) throw new AppError("batch_limit_exceeded", "O lote excede o limite do plano.", 413);
  const maxFileBytes = plan.maxFileMB * 1_024 * 1_024;
  if (input.items.some((item) => item.contentLength > maxFileBytes)) {
    throw new AppError("file_too_large", "Um arquivo excede o limite permitido pelo plano.", 413);
  }
  await dependencies.rateLimit(actor);
  const sessionId = dependencies.randomId();
  const now = dependencies.now();
  const expiresAt = new Date(now.getTime() + positiveIntegerEnv("UNO_BATCH_UPLOAD_SESSION_TTL_SECONDS", DEFAULT_SESSION_TTL_SECONDS) * 1_000);
  const dimensions = sizeDimensions(input.size);
  const templateReference = input.template ?? INITIAL_TEMPLATE;
  await dependencies.database.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${actor.organizationId}, 7))`);
    if (process.env.NODE_ENV !== "production" && process.env.UNO_ALLOW_DRAFT_TEMPLATES === "true") {
      await seedInitialDraftTemplate(transaction);
    }
    const template = await findTemplate(templateReference, transaction);
    assertTemplateEligible(template, input.size);
    const pending = await transaction.select({
      itemCount: count(batchUploadItems.id),
      byteCount: sum(batchUploadItems.contentLength),
    }).from(batchUploadItems).innerJoin(batchUploadSessions, eq(batchUploadSessions.id, batchUploadItems.sessionId)).where(and(
      eq(batchUploadSessions.organizationId, actor.organizationId),
      eq(batchUploadSessions.status, "OPEN"),
      sql`${batchUploadSessions.expiresAt} > now()`,
    ));
    const nextItems = Number(pending[0]?.itemCount ?? 0) + input.items.length;
    const nextBytes = Number(pending[0]?.byteCount ?? 0) + input.items.reduce((total, item) => total + item.contentLength, 0);
    if (nextItems > Math.max(10, plan.batchLimit * 2) || nextBytes > plan.batchLimit * maxFileBytes * 2) {
      throw new AppError("pending_batch_limit_exceeded", "Há muitos arquivos de lote pendentes.", 429, { retryAfterSeconds: 60 });
    }
    await transaction.insert(batchUploadSessions).values({
      id: sessionId,
      organizationId: actor.organizationId,
      createdByUserId: actor.userId,
      templateReference,
      outputPreset: input.size.preset,
      outputWidthMm: String(dimensions.widthMm),
      outputHeightMm: String(dimensions.heightMm),
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });
    await transaction.insert(batchUploadItems).values(input.items.map((item) => ({
      id: dependencies.randomId(),
      organizationId: actor.organizationId,
      sessionId,
      clientItemId: item.clientItemId,
      originalFileName: item.originalFileName,
      contentLength: item.contentLength,
      expectedSha256: item.checksumSha256,
      createdAt: now,
      updatedAt: now,
    })));
  });
  return readBatchUploadSession(actor.organizationId, sessionId, dependencies);
}

function assertMutableSession(
  row: { session: typeof batchUploadSessions.$inferSelect } | undefined,
  now: Date,
): asserts row is { session: typeof batchUploadSessions.$inferSelect; item: typeof batchUploadItems.$inferSelect } {
  if (!row) throw new AppError("not_found", "Item de lote não encontrado.", 404);
  if (row.session.status !== "OPEN") throw new AppError("batch_session_closed", "A sessão de lote já foi encerrada.", 409);
  if (row.session.expiresAt <= now) throw new AppError("batch_session_expired", "A sessão de lote expirou.", 410);
}

export async function issueBatchItemUpload(
  actor: Pick<Actor, "organizationId" | "planId">,
  sessionId: string,
  itemId: string,
  dependencies: BatchUploadDependencies = defaults(),
): Promise<BatchUploadResponse> {
  await dependencies.rateLimit(actor);
  const candidates = await dependencies.database.select({ session: batchUploadSessions, item: batchUploadItems })
    .from(batchUploadItems)
    .innerJoin(batchUploadSessions, eq(batchUploadSessions.id, batchUploadItems.sessionId))
    .where(and(
      eq(batchUploadItems.organizationId, actor.organizationId),
      eq(batchUploadItems.sessionId, sessionId),
      eq(batchUploadItems.id, itemId),
    )).limit(1);
  const row = candidates[0];
  assertMutableSession(row, dependencies.now());
  if (row.item.status === "READY" || row.item.status === "PREPARING") {
    throw new AppError("batch_item_finalized", "O item já foi finalizado.", 409);
  }
  const remainingSessionSeconds = Math.floor((row.session.expiresAt.getTime() - dependencies.now().getTime()) / 1_000);
  if (remainingSessionSeconds < 1) throw new AppError("batch_session_expired", "A sessão de lote expirou.", 410);
  const objectKey = `organizations/${actor.organizationId}/batch-staging/${itemId}.pdf`;
  const signed = await dependencies.storage.signUpload({
    key: objectKey,
    contentLength: row.item.contentLength,
    contentType: "application/pdf",
    checksumSha256: row.item.expectedSha256 ? Buffer.from(row.item.expectedSha256, "hex").toString("base64") : undefined,
    expiresInSeconds: Math.min(SIGNED_UPLOAD_SECONDS, remainingSessionSeconds),
  });
  await dependencies.database.transaction(async (transaction) => {
    const locked = await transaction.select({ session: batchUploadSessions, item: batchUploadItems })
      .from(batchUploadItems)
      .innerJoin(batchUploadSessions, eq(batchUploadSessions.id, batchUploadItems.sessionId))
      .where(and(
        eq(batchUploadItems.organizationId, actor.organizationId),
        eq(batchUploadItems.sessionId, sessionId),
        eq(batchUploadItems.id, itemId),
      )).limit(1).for("update");
    const current = locked[0];
    assertMutableSession(current, dependencies.now());
    if (current.item.status === "READY" || current.item.status === "PREPARING") {
      throw new AppError("batch_item_finalized", "O item já foi finalizado.", 409);
    }
    await transaction.update(batchUploadItems).set({
      status: "UPLOADING",
      stagingObjectKey: objectKey,
      stagingExpiresAt: signed.expiresAt,
      errorCode: null,
      errorMessage: null,
      updatedAt: dependencies.now(),
    }).where(eq(batchUploadItems.id, itemId));
  });
  return { itemId, uploadUrl: signed.url, headers: signed.headers, expiresAt: signed.expiresAt.toISOString() };
}

function hasPdfMagic(bytes: Buffer): boolean {
  return bytes.subarray(0, 1_024).includes(Buffer.from("%PDF-", "ascii"));
}

export async function finalizeBatchUploadItem(
  organizationId: string,
  itemId: string,
  dependencies: Pick<BatchUploadDependencies, "database" | "storage" | "randomId" | "now"> = defaults(),
): Promise<void> {
  const rows = await dependencies.database.select().from(batchUploadItems).where(and(
    eq(batchUploadItems.organizationId, organizationId),
    eq(batchUploadItems.id, itemId),
    eq(batchUploadItems.status, "PREPARING"),
  )).limit(1);
  const item = rows[0];
  if (!item?.stagingObjectKey) return;
  let candidateReadyKey: string | undefined;
  try {
    const head = await dependencies.storage.head(item.stagingObjectKey);
    if (head.contentLength !== item.contentLength || head.contentType?.split(";", 1)[0]?.toLowerCase() !== "application/pdf") {
      throw new AppError("invalid_upload", "O arquivo enviado não corresponde ao manifesto.", 400);
    }
    const bytes = await dependencies.storage.read(item.stagingObjectKey, item.contentLength);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== item.contentLength || !hasPdfMagic(bytes) || (item.expectedSha256 && item.expectedSha256 !== sha256)) {
      throw new AppError("invalid_upload", "O arquivo enviado não corresponde ao manifesto.", 400);
    }
    candidateReadyKey = `organizations/${organizationId}/conversion-inputs/${dependencies.randomId()}.pdf`;
    await dependencies.storage.putBytes(candidateReadyKey, bytes, "application/pdf", item.contentLength);
    const updated = await dependencies.database.transaction(async (transaction) => {
      const locked = await transaction.select({ session: batchUploadSessions, item: batchUploadItems })
        .from(batchUploadItems)
        .innerJoin(batchUploadSessions, eq(batchUploadSessions.id, batchUploadItems.sessionId))
        .where(and(
          eq(batchUploadItems.organizationId, organizationId),
          eq(batchUploadItems.id, item.id),
        )).limit(1).for("update");
      const current = locked[0];
      if (!current || current.session.status !== "OPEN" || current.session.expiresAt <= dependencies.now() ||
        current.item.status !== "PREPARING" || current.item.stagingObjectKey !== item.stagingObjectKey) return [];
      return transaction.update(batchUploadItems).set({
        status: "READY",
        readyObjectKey: candidateReadyKey,
        readySha256: sha256,
        completedAt: dependencies.now(),
        updatedAt: dependencies.now(),
      }).where(and(eq(batchUploadItems.id, item.id), eq(batchUploadItems.status, "PREPARING"))).returning({ id: batchUploadItems.id });
    });
    if (updated.length !== 1) await dependencies.storage.delete(candidateReadyKey).catch(() => undefined);
  } catch (error) {
    if (candidateReadyKey) {
      try {
        const committed = await dependencies.database.transaction(async (transaction) => transaction.select({
          status: batchUploadItems.status,
          readyObjectKey: batchUploadItems.readyObjectKey,
        }).from(batchUploadItems).where(and(
          eq(batchUploadItems.organizationId, organizationId),
          eq(batchUploadItems.id, item.id),
        )).limit(1).for("update"));
        if (committed[0]?.status === "READY" && committed[0].readyObjectKey === candidateReadyKey) {
          return;
        }
        await dependencies.storage.delete(candidateReadyKey).catch(() => undefined);
      } catch {
        // Preserve a possibly committed immutable snapshot when the database outcome is unknown.
        throw error;
      }
    }
    const failure = error instanceof AppError && error.status < 500
      ? { code: "invalid_upload", message: "O arquivo enviado é inválido." }
      : { code: "preparation_unavailable", message: "Não foi possível preparar o arquivo agora." };
    await dependencies.database.update(batchUploadItems).set({
      status: failure.code === "invalid_upload" ? "FAILED" : "UPLOADING",
      errorCode: failure.code,
      errorMessage: failure.message,
      updatedAt: dependencies.now(),
    }).where(and(eq(batchUploadItems.id, item.id), eq(batchUploadItems.status, "PREPARING")));
    if (failure.code !== "invalid_upload") throw error;
  }
}

export async function completeBatchItemUpload(
  actor: Pick<Actor, "organizationId" | "planId">,
  sessionId: string,
  itemId: string,
  dependencies: BatchUploadDependencies = defaults(),
): Promise<{ session: BatchUploadSession; preparing: boolean }> {
  await dependencies.rateLimit(actor);
  const transition = await dependencies.database.transaction(async (transaction) => {
    const locked = await transaction.select({ session: batchUploadSessions, item: batchUploadItems })
      .from(batchUploadItems)
      .innerJoin(batchUploadSessions, eq(batchUploadSessions.id, batchUploadItems.sessionId))
      .where(and(
        eq(batchUploadItems.organizationId, actor.organizationId),
        eq(batchUploadItems.sessionId, sessionId),
        eq(batchUploadItems.id, itemId),
      )).limit(1).for("update");
    const current = locked[0];
    assertMutableSession(current, dependencies.now());
    if (current.item.status === "READY") return { ready: true, contentLength: current.item.contentLength };
    if (!current.item.stagingObjectKey || current.item.status !== "UPLOADING") {
      throw new AppError("batch_item_not_uploaded", "Envie o arquivo antes de finalizar.", 409);
    }
    await transaction.update(batchUploadItems).set({
      status: "PREPARING",
      updatedAt: dependencies.now(),
    }).where(eq(batchUploadItems.id, itemId));
    return { ready: false, contentLength: current.item.contentLength };
  });
  if (transition.ready) {
    return { session: await readBatchUploadSession(actor.organizationId, sessionId, dependencies), preparing: false };
  }
  const preparing = transition.contentLength > SYNC_FINALIZE_MAX_BYTES;
  if (!preparing) await finalizeBatchUploadItem(actor.organizationId, itemId, dependencies);
  return { session: await readBatchUploadSession(actor.organizationId, sessionId, dependencies), preparing };
}

export async function finalizePreparingBatchUploads(
  dependencies: Pick<BatchUploadDependencies, "database" | "storage" | "randomId" | "now"> = defaults(),
): Promise<number> {
  const rows = await dependencies.database.select({ id: batchUploadItems.id, organizationId: batchUploadItems.organizationId })
    .from(batchUploadItems).innerJoin(batchUploadSessions, eq(batchUploadSessions.id, batchUploadItems.sessionId))
    .where(and(
      eq(batchUploadItems.status, "PREPARING"),
      eq(batchUploadSessions.status, "OPEN"),
      sql`${batchUploadSessions.expiresAt} > now()`,
      sql`${batchUploadItems.updatedAt} < now() - interval '5 seconds'`,
    )).limit(5);
  for (const row of rows) await finalizeBatchUploadItem(row.organizationId, row.id, dependencies).catch(() => undefined);
  return rows.length;
}

export async function cleanupExpiredBatchUploadSessions(
  dependencies: Pick<BatchUploadDependencies, "database" | "storage" | "now"> = defaults(),
): Promise<number> {
  const expired = await dependencies.database.transaction(async (transaction) => {
    const rows = await transaction.select({ id: batchUploadSessions.id }).from(batchUploadSessions).where(and(
      sql`${batchUploadSessions.expiresAt} <= now()`,
      sql`(
        ${batchUploadSessions.status} = 'OPEN'
        or (
          ${batchUploadSessions.status} = 'EXPIRED'
          and exists (
            select 1 from batch_upload_items i
            where i.session_id = ${batchUploadSessions.id}
              and (i.staging_object_key is not null or i.ready_object_key is not null)
          )
        )
      )`,
    )).limit(10).for("update", { skipLocked: true });
    if (!rows.length) return [];
    const sessionIds = rows.map((row) => row.id);
    await transaction.update(batchUploadSessions).set({
      status: "EXPIRED",
      updatedAt: dependencies.now(),
    }).where(inArray(batchUploadSessions.id, sessionIds));
    return transaction.select({
      id: batchUploadItems.id,
      stagingObjectKey: batchUploadItems.stagingObjectKey,
      readyObjectKey: batchUploadItems.readyObjectKey,
    }).from(batchUploadItems).where(inArray(batchUploadItems.sessionId, sessionIds));
  });
  for (const item of expired) {
    const keys = [item.stagingObjectKey, item.readyObjectKey].filter((key): key is string => Boolean(key));
    const deleted = await Promise.allSettled(keys.map((key) => dependencies.storage.delete(key)));
    if (deleted.some((result) => result.status === "rejected")) continue;
    await dependencies.database.update(batchUploadItems).set({
      status: "FAILED",
      stagingObjectKey: null,
      stagingExpiresAt: null,
      readyObjectKey: null,
      readySha256: null,
      errorCode: "batch_session_expired",
      errorMessage: "A sessão de lote expirou.",
      updatedAt: dependencies.now(),
    }).where(eq(batchUploadItems.id, item.id));
  }
  return expired.length;
}

export async function cleanupExpiredBatchStagingObjects(
  dependencies: Pick<BatchUploadDependencies, "database" | "storage" | "now"> = defaults(),
): Promise<number> {
  const rows = await dependencies.database.select({
    id: batchUploadItems.id,
    stagingObjectKey: batchUploadItems.stagingObjectKey,
    stagingExpiresAt: batchUploadItems.stagingExpiresAt,
  }).from(batchUploadItems).innerJoin(batchUploadSessions, eq(batchUploadSessions.id, batchUploadItems.sessionId)).where(and(
    sql`${batchUploadItems.stagingObjectKey} is not null`,
    sql`${batchUploadItems.stagingExpiresAt} <= now()`,
    sql`(${batchUploadItems.status} = 'READY' or ${batchUploadSessions.status} <> 'OPEN')`,
  )).limit(25);
  for (const row of rows) {
    if (!row.stagingObjectKey || !row.stagingExpiresAt) continue;
    try {
      await dependencies.storage.delete(row.stagingObjectKey);
    } catch {
      continue;
    }
    await dependencies.database.update(batchUploadItems).set({
      stagingObjectKey: null,
      stagingExpiresAt: null,
      updatedAt: dependencies.now(),
    }).where(and(
      eq(batchUploadItems.id, row.id),
      eq(batchUploadItems.stagingObjectKey, row.stagingObjectKey),
      eq(batchUploadItems.stagingExpiresAt, row.stagingExpiresAt),
    ));
  }
  return rows.length;
}

export type { BatchUploadDependencies };
