import { and, eq, lte, ne } from "drizzle-orm";

import { apiRequests, apiRequestUploads, getDb, type UnoDatabase } from "@/db";
import { getStorage, type StorageGateway } from "@/server/storage";

type CleanupDependencies = {
  database: UnoDatabase;
  storage: StorageGateway;
  now(): Date;
};

function defaults(): CleanupDependencies {
  return { database: getDb(), storage: getStorage(), now: () => new Date() };
}

export async function cleanupExpiredApiPreparations(
  dependencies: CleanupDependencies = defaults(),
  limit = 100,
): Promise<number> {
  const now = dependencies.now();
  const candidates = await dependencies.database.select({
    id: apiRequestUploads.id,
    organizationId: apiRequestUploads.organizationId,
    apiRequestId: apiRequestUploads.apiRequestId,
  }).from(apiRequestUploads).where(and(
    ne(apiRequestUploads.status, "COMMITTED"),
    lte(apiRequestUploads.cleanupAfter, now),
  )).limit(Math.max(1, Math.min(500, limit)));
  let cleaned = 0;
  for (const candidate of candidates) {
    const row = await dependencies.database.transaction(async (transaction) => {
      const requestRows = await transaction.select().from(apiRequests).where(and(
        eq(apiRequests.organizationId, candidate.organizationId),
        eq(apiRequests.id, candidate.apiRequestId),
      )).limit(1).for("update");
      const request = requestRows[0];
      const uploadRows = await transaction.select().from(apiRequestUploads).where(and(
        eq(apiRequestUploads.organizationId, candidate.organizationId),
        eq(apiRequestUploads.id, candidate.id),
      )).limit(1).for("update");
      const upload = uploadRows[0];
      if (!upload || upload.status === "COMMITTED" || upload.cleanupAfter > dependencies.now()) return null;
      await transaction.update(apiRequestUploads).set({ status: "ABORTED", updatedAt: dependencies.now() })
        .where(eq(apiRequestUploads.id, upload.id));
      if (request?.status === "PENDING") {
        await transaction.update(apiRequests).set({ status: "FAILED", completedAt: dependencies.now(), updatedAt: dependencies.now() })
          .where(eq(apiRequests.id, request.id));
      }
      return upload;
    });
    if (!row) continue;
    if (row.multipartUploadId && row.status === "PREPARING") {
      await dependencies.storage.abortMultipartUpload(row.objectKey, row.multipartUploadId).catch(() => undefined);
    }
    await dependencies.storage.delete(row.objectKey).catch(() => undefined);
    cleaned += 1;
  }
  return cleaned;
}

export type { CleanupDependencies };
