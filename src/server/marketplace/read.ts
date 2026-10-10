import { and, eq, sql } from "drizzle-orm";

import { batches, getDb, type UnoDatabase } from "@/db";
import { AppError } from "@/lib/errors";
import { getStorage, type StorageGateway } from "@/server/storage";

const notRetired = sql`${batches.status} not in ('deleting','deleted')`;

export type MarketplaceLoteView = {
  id: string;
  marketplace: string | null;
  status: string;
  phase: string;
  progress: number;
  itemCount: number;
  completedCount: number;
  failedCount: number;
  createdAt: string;
  completedAt: string | null;
  /** True once the combined PDF is ready to download. */
  downloadAvailable: boolean;
  error?: { code: string; message: string };
};

async function loadMarketplaceLote(organizationId: string, batchId: string, database: UnoDatabase) {
  const rows = await database.select().from(batches).where(and(
    eq(batches.organizationId, organizationId),
    eq(batches.id, batchId),
    eq(batches.kind, "marketplace"),
    notRetired,
  )).limit(1);
  if (!rows[0]) throw new AppError("not_found", "Lote não encontrado.", 404);
  return rows[0];
}

export async function readMarketplaceLote(
  organizationId: string,
  batchId: string,
  database: UnoDatabase = getDb(),
): Promise<MarketplaceLoteView> {
  const batch = await loadMarketplaceLote(organizationId, batchId, database);
  return {
    id: batch.id,
    marketplace: batch.marketplace,
    status: batch.status,
    phase: batch.phase,
    progress: batch.progress,
    itemCount: batch.itemCount,
    completedCount: batch.completedCount,
    failedCount: batch.failedCount,
    createdAt: batch.createdAt.toISOString(),
    completedAt: batch.completedAt?.toISOString() ?? null,
    downloadAvailable: batch.status === "completed" && batch.archiveStatus === "READY" && Boolean(batch.combinedPdfObjectKey),
    ...(batch.status === "failed" && batch.archiveErrorCode && batch.archiveErrorMessage
      ? { error: { code: batch.archiveErrorCode, message: batch.archiveErrorMessage } }
      : {}),
  };
}

type DownloadDependencies = { database: UnoDatabase; storage: StorageGateway; now(): Date };

function downloadDefaults(): DownloadDependencies {
  return { database: getDb(), storage: getStorage(), now: () => new Date() };
}

export async function signMarketplaceLoteDownload(
  organizationId: string,
  batchId: string,
  dependencies: DownloadDependencies = downloadDefaults(),
): Promise<{ url: string; expiresAt: string }> {
  const batch = await loadMarketplaceLote(organizationId, batchId, dependencies.database);
  if (batch.status !== "completed" || batch.archiveStatus !== "READY" || !batch.combinedPdfObjectKey || !batch.artifactsExpireAt) {
    throw new AppError("archive_unavailable", "O PDF do lote não está disponível.", 410);
  }
  const remaining = batch.artifactsExpireAt.getTime() - dependencies.now().getTime();
  if (remaining < 1_000) throw new AppError("archive_unavailable", "O PDF do lote expirou.", 410);
  await dependencies.storage.head(batch.combinedPdfObjectKey).catch((error) => {
    if (error instanceof AppError && error.code === "upload_not_found") {
      throw new AppError("archive_unavailable", "O PDF do lote não está disponível.", 410);
    }
    throw error;
  });
  const signed = await dependencies.storage.signDownload(batch.combinedPdfObjectKey, Math.min(300, Math.floor(remaining / 1_000)));
  return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
}
