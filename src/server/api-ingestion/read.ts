import { and, asc, eq, sql } from "drizzle-orm";

import { batches, conversions, getDb, type UnoDatabase } from "@/db";
import { publicBatchSchema, publicConversionSchema, publicUsageSchema, type PublicBatch, type PublicConversion, type PublicUsage } from "@/lib/api-model";
import { AppError } from "@/lib/errors";
import { readUsageState } from "@/server/billing";
import { readBatch, signBatchDownload } from "@/server/batches";
import { readConversion } from "@/server/conversions";

import type { ApiActor } from "../api-keys";

export async function readPublicConversion(
  actor: ApiActor,
  conversionId: string,
  database: UnoDatabase = getDb(),
): Promise<PublicConversion> {
  const scoped = await database.select({
    updatedAt: conversions.updatedAt,
    templateVersion: conversions.templateVersion,
  }).from(conversions).where(and(
    eq(conversions.organizationId, actor.organizationId),
    eq(conversions.id, conversionId),
    eq(conversions.source, "api"),
    sql`${conversions.status} not in ('deleting','deleted')`,
  )).limit(1);
  if (!scoped[0]) throw new AppError("not_found", "Conversão não encontrada.", 404);
  const internal = await readConversion(actor.organizationId, conversionId, { database, storage: (await import("@/server/storage")).getStorage(), now: () => new Date() });
  return publicConversionSchema.parse({
    id: internal.id,
    status: internal.status,
    progress: internal.progress,
    ...(internal.stage ? { stage: internal.stage } : {}),
    template: internal.template.split("@", 1)[0],
    templateVersion: scoped[0].templateVersion,
    engineVersion: internal.engineVersion,
    size: internal.size,
    createdAt: internal.createdAt,
    updatedAt: scoped[0].updatedAt.toISOString(),
    completedAt: internal.completedAt,
    ...(internal.download ? { download: internal.download } : {}),
    ...(internal.error ? { error: internal.error } : {}),
  });
}

export async function readPublicBatch(
  actor: ApiActor,
  batchId: string,
  database: UnoDatabase = getDb(),
): Promise<PublicBatch> {
  const scoped = await database.select({ id: batches.id }).from(batches).where(and(
    eq(batches.organizationId, actor.organizationId), eq(batches.id, batchId),
    sql`${batches.apiKeyId} is not null`,
    sql`${batches.status} not in ('deleting','deleted')`,
  )).limit(1);
  if (!scoped[0]) throw new AppError("not_found", "Lote não encontrado.", 404);
  const detail = await readBatch(actor.organizationId, batchId, database);
  const rows = await database.select({
    id: conversions.id,
    status: conversions.status,
    progress: conversions.progress,
    originalFileName: conversions.originalFileName,
    createdAt: conversions.createdAt,
    completedAt: conversions.completedAt,
    errorCode: conversions.errorCode,
    errorMessage: conversions.errorMessage,
  }).from(conversions).where(and(
    eq(conversions.organizationId, actor.organizationId), eq(conversions.batchId, batchId), eq(conversions.source, "api"),
    sql`${conversions.status} not in ('deleting','deleted')`,
  )).orderBy(asc(conversions.createdAt), asc(conversions.id));
  let download: { url: string; expiresAt: string } | undefined;
  if (detail.status === "completed" && detail.archive.status === "ready") {
    try { download = await signBatchDownload(actor.organizationId, batchId); } catch (error) {
      if (!(error instanceof AppError && error.code === "archive_unavailable")) throw error;
    }
  }
  return publicBatchSchema.parse({
    id: detail.id,
    status: detail.status,
    phase: detail.phase,
    progress: detail.progress,
    counts: detail.counts,
    items: rows.map((row) => ({
      id: row.id,
      status: row.status,
      progress: row.progress,
      originalFileName: row.originalFileName,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      ...(row.status === "failed" && row.errorCode && row.errorMessage ? { error: { code: row.errorCode, message: row.errorMessage } } : {}),
    })),
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    completedAt: detail.completedAt,
    ...(download ? { download } : {}),
    ...(detail.archive.status === "failed" && detail.archive.error ? { error: detail.archive.error } : {}),
  });
}

export async function readPublicUsage(
  actor: ApiActor,
  database: UnoDatabase = getDb(),
): Promise<PublicUsage> {
  const usage = await readUsageState({ organizationId: actor.organizationId }, database);
  return publicUsageSchema.parse({ planId: actor.planId, ...usage.current });
}
