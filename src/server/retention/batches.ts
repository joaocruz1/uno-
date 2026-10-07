import { and, asc, eq, isNull, lt, lte, ne, or, sql } from "drizzle-orm";

import { batches, conversions, outboxEvents } from "@/db";

import {
  batchAttemptArchiveKey,
  deferUntil,
  deleteRegisteredObjects,
  emptySummary,
  leaseIsValid,
  type RetentionDependencies,
  type RetentionSummary,
} from "./shared";

type Candidate = { id: string; organizationId: string };

type Claim =
  | { outcome: "skip" }
  | { outcome: "deferred" }
  | { outcome: "claimed"; token: string; keys: string[] };

async function claimBatch(candidate: Candidate, dependencies: RetentionDependencies): Promise<Claim> {
  return dependencies.database.transaction(async (transaction): Promise<Claim> => {
    const now = dependencies.now();
    const rows = await transaction.select().from(batches).where(and(
      eq(batches.organizationId, candidate.organizationId),
      eq(batches.id, candidate.id),
    )).limit(1).for("update");
    const row = rows[0];
    if (
      !row || row.status === "deleted" ||
      !row.artifactsExpireAt || row.artifactsExpireAt.getTime() > now.getTime() ||
      leaseIsValid(row.retentionLeaseExpiresAt, now)
    ) {
      return { outcome: "skip" };
    }

    const defer = async (activeLease?: Date | null): Promise<Claim> => {
      await transaction.update(batches).set({
        retentionLeaseExpiresAt: deferUntil(now, dependencies.leaseMs, activeLease),
      }).where(eq(batches.id, row.id));
      return { outcome: "deferred" };
    };

    const token = dependencies.randomId();
    const retentionLeaseExpiresAt = new Date(now.getTime() + dependencies.leaseMs);
    if (row.status === "deleting") {
      await transaction.update(batches).set({ retentionToken: token, retentionLeaseExpiresAt, updatedAt: now })
        .where(eq(batches.id, row.id));
      return { outcome: "claimed", token, keys: row.zipObjectKey ? [row.zipObjectKey] : [] };
    }

    // The packager owns the archive while its lease is valid.
    if (row.archiveStatus === "PACKAGING" && leaseIsValid(row.archiveLeaseExpiresAt, now)) {
      return defer(row.archiveLeaseExpiresAt);
    }

    let zipObjectKey = row.zipObjectKey;
    if (row.status === "queued" || row.status === "processing") {
      // Close the aggregate from the children while they still carry their
      // terminal states; their tombstones must not change these counts later.
      const children = await transaction.select({
        completed: sql<number>`count(*) filter (where ${conversions.status} = 'completed')::integer`,
        failed: sql<number>`count(*) filter (where ${conversions.status} = 'failed')::integer`,
        active: sql<number>`count(*) filter (where ${conversions.status} = 'processing' and ${conversions.processingLeaseExpiresAt} >= ${now.toISOString()}::timestamptz)::integer`,
      }).from(conversions).where(and(
        eq(conversions.organizationId, row.organizationId),
        eq(conversions.batchId, row.id),
      ));
      const counts = children[0] ?? { completed: 0, failed: 0, active: 0 };
      if (counts.active > 0) return defer();
      if (row.archiveStatus === "PACKAGING" && row.archiveToken && !zipObjectKey) {
        // A fenced packager may have published its attempt object without committing it.
        zipObjectKey = batchAttemptArchiveKey(row.organizationId, row.id, row.archiveToken);
      }
      await transaction.update(batches).set({
        status: "deleting",
        phase: "failed",
        progress: 100,
        completedCount: counts.completed,
        failedCount: counts.failed,
        archiveStatus: "FAILED",
        archiveToken: null,
        archiveLeaseExpiresAt: null,
        archiveErrorCode: "archive_expired",
        archiveErrorMessage: "Os resultados do lote expiraram.",
        zipObjectKey,
        completedAt: row.completedAt ?? now,
        retentionToken: token,
        retentionLeaseExpiresAt,
        updatedAt: now,
      }).where(eq(batches.id, row.id));
      await transaction.insert(outboxEvents).values({
        id: dependencies.randomId(),
        organizationId: row.organizationId,
        type: "batch.completed",
        aggregateType: "batch",
        aggregateId: row.id,
        deduplicationKey: `batch.completed.${row.id}`,
        payload: { batchId: row.id, status: "failed", completedCount: counts.completed, failedCount: counts.failed },
      }).onConflictDoNothing({ target: outboxEvents.deduplicationKey });
    } else {
      await transaction.update(batches).set({
        status: "deleting",
        retentionToken: token,
        retentionLeaseExpiresAt,
        updatedAt: now,
      }).where(eq(batches.id, row.id));
    }
    return { outcome: "claimed", token, keys: zipObjectKey ? [zipObjectKey] : [] };
  });
}

async function confirmDeleted(candidate: Candidate, token: string, dependencies: RetentionDependencies): Promise<boolean> {
  const now = dependencies.now();
  const updated = await dependencies.database.update(batches).set({
    status: "deleted",
    deletedAt: now,
    retentionToken: null,
    retentionLeaseExpiresAt: null,
    updatedAt: now,
  }).where(and(
    eq(batches.organizationId, candidate.organizationId),
    eq(batches.id, candidate.id),
    eq(batches.status, "deleting"),
    eq(batches.retentionToken, token),
  )).returning({ id: batches.id });
  return updated.length === 1;
}

/**
 * Removes expired batch archives. Runs before conversion cleanup so every
 * batch aggregate is closed before its children become tombstones.
 */
export async function cleanupExpiredBatches(
  dependencies: RetentionDependencies,
  limit: number,
): Promise<RetentionSummary> {
  const now = dependencies.now();
  const candidates = await dependencies.database.select({
    id: batches.id,
    organizationId: batches.organizationId,
  }).from(batches).where(and(
    ne(batches.status, "deleted"),
    lte(batches.artifactsExpireAt, now),
    or(isNull(batches.retentionLeaseExpiresAt), lt(batches.retentionLeaseExpiresAt, now)),
  )).orderBy(asc(batches.artifactsExpireAt), asc(batches.id)).limit(Math.max(1, Math.min(500, Math.trunc(limit))));

  const summary = emptySummary();
  for (const candidate of candidates) {
    try {
      const claim = await claimBatch(candidate, dependencies);
      if (claim.outcome === "deferred") summary.deferred += 1;
      if (claim.outcome !== "claimed") continue;
      if (!await deleteRegisteredObjects(claim.keys, dependencies.storage)) {
        summary.failed += 1;
        continue;
      }
      if (await confirmDeleted(candidate, claim.token, dependencies)) summary.deleted += 1;
    } catch {
      // An inconclusive database result never confirms a tombstone; retried later.
      summary.failed += 1;
    }
  }
  return summary;
}
