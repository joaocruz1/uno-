import { and, eq } from "drizzle-orm";

import { batches, conversions } from "@/db";

import {
  batchAttemptArchiveKey,
  conversionAttemptOutputKey,
  type RetentionDependencies,
} from "./shared";

/**
 * An object that an interrupted attempt may have left behind. A candidate is
 * only actionable when it names its organization, the owning record, the
 * attempt that wrote it and the earliest instant it may be examined. Keys
 * without such an owner are operational inventory and are never deleted here;
 * the bucket is never listed or swept.
 */
export type OrphanCandidate = {
  kind: "conversion-output-attempt" | "batch-archive-attempt";
  organizationId: string;
  ownerId: string;
  attemptToken: string;
  key: string;
  notBefore: Date;
};

export type OrphanDecision =
  | { action: "deleted" }
  | {
    action: "preserved";
    reason: "not_due" | "key_mismatch" | "owner_unknown" | "referenced" | "attempt_active" | "inconclusive" | "storage_failed";
  };

type OwnerState = "unknown" | "referenced" | "attempt_active" | "orphan";

async function ownerState(candidate: OrphanCandidate, dependencies: Pick<RetentionDependencies, "database">): Promise<OwnerState> {
  return dependencies.database.transaction(async (transaction): Promise<OwnerState> => {
    if (candidate.kind === "conversion-output-attempt") {
      const rows = await transaction.select({
        status: conversions.status,
        outputObjectKey: conversions.outputObjectKey,
        processingToken: conversions.processingToken,
      }).from(conversions).where(and(
        eq(conversions.organizationId, candidate.organizationId),
        eq(conversions.id, candidate.ownerId),
      )).limit(1).for("update");
      const row = rows[0];
      if (!row) return "unknown";
      if (row.outputObjectKey === candidate.key) return "referenced";
      // The attempt can still commit this key while it owns the claim.
      if (row.status === "processing" && row.processingToken === candidate.attemptToken) return "attempt_active";
      return "orphan";
    }
    const rows = await transaction.select({
      zipObjectKey: batches.zipObjectKey,
      archiveStatus: batches.archiveStatus,
      archiveToken: batches.archiveToken,
    }).from(batches).where(and(
      eq(batches.organizationId, candidate.organizationId),
      eq(batches.id, candidate.ownerId),
    )).limit(1).for("update");
    const row = rows[0];
    if (!row) return "unknown";
    if (row.zipObjectKey === candidate.key) return "referenced";
    if (row.archiveStatus === "PACKAGING" && row.archiveToken === candidate.attemptToken) return "attempt_active";
    return "orphan";
  });
}

/**
 * Decides one orphan candidate. The owner row is re-read under lock, which
 * waits for any commit of unknown outcome to settle first. Deletion happens
 * only when that row exists, does not reference the key and has fenced the
 * attempt for good. A missing owner, a database error or any doubt preserves
 * the object: age or an isolated query never proves orphanhood.
 */
export async function collectOrphanCandidate(
  candidate: OrphanCandidate,
  dependencies: Pick<RetentionDependencies, "database" | "storage" | "now">,
): Promise<OrphanDecision> {
  const expectedKey = candidate.kind === "conversion-output-attempt"
    ? conversionAttemptOutputKey(candidate.organizationId, candidate.ownerId, candidate.attemptToken)
    : batchAttemptArchiveKey(candidate.organizationId, candidate.ownerId, candidate.attemptToken);
  if (!expectedKey || expectedKey !== candidate.key) return { action: "preserved", reason: "key_mismatch" };
  if (candidate.notBefore.getTime() > dependencies.now().getTime()) return { action: "preserved", reason: "not_due" };

  let state: OwnerState;
  try {
    state = await ownerState(candidate, dependencies);
  } catch {
    return { action: "preserved", reason: "inconclusive" };
  }
  if (state === "unknown") return { action: "preserved", reason: "owner_unknown" };
  if (state === "referenced") return { action: "preserved", reason: "referenced" };
  if (state === "attempt_active") return { action: "preserved", reason: "attempt_active" };
  try {
    await dependencies.storage.delete(expectedKey, AbortSignal.timeout(15_000));
  } catch {
    return { action: "preserved", reason: "storage_failed" };
  }
  return { action: "deleted" };
}
