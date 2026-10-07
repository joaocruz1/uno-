import { and, asc, eq, isNull, lt, lte, ne, or } from "drizzle-orm";

import {
  apiRequestUploads,
  batchUploadItems,
  batches,
  conversions,
  uploadIntents,
  usageReservations,
} from "@/db";
import { releaseUsage } from "@/db/usage";

import {
  conversionAttemptOutputKey,
  deferUntil,
  deleteRegisteredObjects,
  emptySummary,
  leaseIsValid,
  type RetentionDependencies,
  type RetentionSummary,
} from "./shared";

/** Replaces a mandatory file-name column once its artifact is gone. */
export const REMOVED_FILE_NAME = "removido";

type Candidate = { id: string; organizationId: string; batchId: string | null };

type Claim =
  | { outcome: "skip" }
  | { outcome: "deferred" }
  | { outcome: "claimed"; token: string; keys: string[]; inputObjectKey: string; uploadIntentId: string | null };

/**
 * Claims one expired conversion under row locks. The batch row is locked first
 * (same order as every other writer) so a child is never tombstoned while its
 * batch aggregate is still open.
 */
async function claimConversion(candidate: Candidate, dependencies: RetentionDependencies): Promise<Claim> {
  return dependencies.database.transaction(async (transaction): Promise<Claim> => {
    const now = dependencies.now();
    let batch: { status: string; artifactsExpireAt: Date | null } | undefined;
    if (candidate.batchId) {
      const batchRows = await transaction.select({
        status: batches.status,
        artifactsExpireAt: batches.artifactsExpireAt,
      }).from(batches).where(and(
        eq(batches.organizationId, candidate.organizationId),
        eq(batches.id, candidate.batchId),
      )).limit(1).for("update");
      batch = batchRows[0];
    }
    const rows = await transaction.select().from(conversions).where(and(
      eq(conversions.organizationId, candidate.organizationId),
      eq(conversions.id, candidate.id),
    )).limit(1).for("update");
    const row = rows[0];
    if (
      !row || row.status === "deleted" || row.batchId !== candidate.batchId ||
      !row.artifactsExpireAt || row.artifactsExpireAt.getTime() > now.getTime() ||
      leaseIsValid(row.retentionLeaseExpiresAt, now)
    ) {
      return { outcome: "skip" };
    }

    const defer = async (activeLease?: Date | null): Promise<Claim> => {
      await transaction.update(conversions).set({
        retentionLeaseExpiresAt: deferUntil(now, dependencies.leaseMs, activeLease),
      }).where(eq(conversions.id, row.id));
      return { outcome: "deferred" };
    };

    let fencedAttemptKey: string | null = null;
    if (row.status !== "deleting") {
      // Active work is fenced before any object is removed, never under a valid lease.
      if (row.status === "processing" && leaseIsValid(row.processingLeaseExpiresAt, now)) {
        return defer(row.processingLeaseExpiresAt);
      }
      if (row.batchId) {
        const batchClosed = batch && (
          batch.status === "deleting" || batch.status === "deleted" ||
          // A terminal batch that outlives this child keeps its stored aggregate.
          ((batch.status === "completed" || batch.status === "failed") &&
            (!batch.artifactsExpireAt || batch.artifactsExpireAt.getTime() > now.getTime()))
        );
        if (!batchClosed) return defer();
      }
      if (row.status === "processing" && row.processingToken && !row.outputObjectKey) {
        // The fenced attempt may have published its output without committing it.
        // Registering the deterministic attempt key keeps the deletion retryable.
        fencedAttemptKey = conversionAttemptOutputKey(row.organizationId, row.id, row.processingToken);
      }
      if (row.status === "queued" || row.status === "processing") {
        const reservations = await transaction.select({
          id: usageReservations.id,
          status: usageReservations.status,
        }).from(usageReservations).where(and(
          eq(usageReservations.organizationId, row.organizationId),
          eq(usageReservations.conversionId, row.id),
        )).limit(1).for("update");
        const reservation = reservations[0];
        // Confirmed usage is accounting history and is never touched.
        if (reservation?.status === "RESERVED") await releaseUsage(reservation.id, row.organizationId, transaction);
      }
    }

    const token = dependencies.randomId();
    const outputObjectKey = row.outputObjectKey ?? fencedAttemptKey;
    const updated = await transaction.update(conversions).set({
      status: "deleting",
      processingToken: null,
      processingLeaseExpiresAt: null,
      outputObjectKey,
      retentionToken: token,
      retentionLeaseExpiresAt: new Date(now.getTime() + dependencies.leaseMs),
      updatedAt: now,
    }).where(eq(conversions.id, row.id)).returning({ id: conversions.id });
    if (updated.length !== 1) return { outcome: "skip" };

    const keys = [row.inputObjectKey];
    if (outputObjectKey) keys.push(outputObjectKey);
    if (row.uploadIntentId) {
      const intents = await transaction.select({ objectKey: uploadIntents.objectKey }).from(uploadIntents).where(and(
        eq(uploadIntents.organizationId, row.organizationId),
        eq(uploadIntents.id, row.uploadIntentId),
      )).limit(1);
      if (intents[0]) keys.push(intents[0].objectKey);
    }
    return { outcome: "claimed", token, keys, inputObjectKey: row.inputObjectKey, uploadIntentId: row.uploadIntentId };
  });
}

/**
 * Confirms the tombstone only for the claim that deleted the objects. IDs,
 * foreign keys, source, counters and processing events stay; the original file
 * name is removed from the conversion and from the upload records behind it.
 */
async function confirmDeleted(
  candidate: Candidate,
  claim: Extract<Claim, { outcome: "claimed" }>,
  dependencies: RetentionDependencies,
): Promise<boolean> {
  return dependencies.database.transaction(async (transaction) => {
    const now = dependencies.now();
    const updated = await transaction.update(conversions).set({
      status: "deleted",
      deletedAt: now,
      originalFileName: null,
      retentionToken: null,
      retentionLeaseExpiresAt: null,
      updatedAt: now,
    }).where(and(
      eq(conversions.organizationId, candidate.organizationId),
      eq(conversions.id, candidate.id),
      eq(conversions.status, "deleting"),
      eq(conversions.retentionToken, claim.token),
    )).returning({ id: conversions.id });
    if (updated.length !== 1) return false;
    if (claim.uploadIntentId) {
      await transaction.update(uploadIntents).set({ originalFileName: null }).where(and(
        eq(uploadIntents.organizationId, candidate.organizationId),
        eq(uploadIntents.id, claim.uploadIntentId),
      ));
    }
    await transaction.update(batchUploadItems).set({ originalFileName: REMOVED_FILE_NAME, updatedAt: now }).where(and(
      eq(batchUploadItems.organizationId, candidate.organizationId),
      eq(batchUploadItems.readyObjectKey, claim.inputObjectKey),
    ));
    await transaction.update(apiRequestUploads).set({ originalFileName: REMOVED_FILE_NAME, updatedAt: now }).where(and(
      eq(apiRequestUploads.organizationId, candidate.organizationId),
      eq(apiRequestUploads.objectKey, claim.inputObjectKey),
    ));
    return true;
  });
}

/**
 * Removes the artifacts of conversions whose retention fixed at acceptance has
 * elapsed. Bounded, idempotent and safe to run from several workers at once.
 */
export async function cleanupExpiredConversions(
  dependencies: RetentionDependencies,
  limit: number,
): Promise<RetentionSummary> {
  const now = dependencies.now();
  const candidates = await dependencies.database.select({
    id: conversions.id,
    organizationId: conversions.organizationId,
    batchId: conversions.batchId,
  }).from(conversions).where(and(
    ne(conversions.status, "deleted"),
    lte(conversions.artifactsExpireAt, now),
    or(isNull(conversions.retentionLeaseExpiresAt), lt(conversions.retentionLeaseExpiresAt, now)),
  )).orderBy(asc(conversions.artifactsExpireAt), asc(conversions.id)).limit(Math.max(1, Math.min(500, Math.trunc(limit))));

  const summary = emptySummary();
  for (const candidate of candidates) {
    try {
      const claim = await claimConversion(candidate, dependencies);
      if (claim.outcome === "deferred") summary.deferred += 1;
      if (claim.outcome !== "claimed") continue;
      if (!await deleteRegisteredObjects(claim.keys, dependencies.storage)) {
        // The row stays `deleting`; the claim expires and the next run retries.
        summary.failed += 1;
        continue;
      }
      if (await confirmDeleted(candidate, claim, dependencies)) summary.deleted += 1;
    } catch {
      // An inconclusive database result never confirms a tombstone; retried later.
      summary.failed += 1;
    }
  }
  return summary;
}
