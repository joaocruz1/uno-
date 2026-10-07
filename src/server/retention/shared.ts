import type { UnoDatabase } from "@/db";
import type { StorageGateway } from "@/server/storage";

export type RetentionDependencies = {
  database: UnoDatabase;
  storage: Pick<StorageGateway, "delete">;
  randomId(): string;
  now(): Date;
  /** Lifetime of a retention claim. An interrupted deletion is retried once it elapses. */
  leaseMs: number;
};

export type RetentionSummary = {
  /** Records fully tombstoned in this run. */
  deleted: number;
  /** Records left alone because active work still holds a valid lease. */
  deferred: number;
  /** Records claimed whose objects could not all be removed; retried after the lease. */
  failed: number;
};

export const emptySummary = (): RetentionSummary => ({ deleted: 0, deferred: 0, failed: 0 });

/** Upper bound for a single provider delete so one stuck call cannot outlive the claim. */
const DELETE_TIMEOUT_MS = 15_000;
/** How long a record that cannot be claimed yet is skipped by candidate selection. */
const MAX_DEFER_MS = 60_000;

export function deferUntil(now: Date, leaseMs: number, activeLeaseExpiresAt?: Date | null): Date {
  const ceiling = now.getTime() + Math.min(MAX_DEFER_MS, leaseMs);
  const active = activeLeaseExpiresAt ? activeLeaseExpiresAt.getTime() + 1 : ceiling;
  return new Date(Math.max(now.getTime() + 1, Math.min(ceiling, active)));
}

/** A lease protects its holder up to and including its expiry instant. */
export function leaseIsValid(expiresAt: Date | null | undefined, now: Date): boolean {
  return Boolean(expiresAt && expiresAt.getTime() >= now.getTime());
}

/**
 * Deletes exactly the given registered keys. Deleting an absent object succeeds,
 * so a partially completed run can be repeated safely. Returns false when any
 * object may still exist; nothing about the keys is logged or returned.
 */
export async function deleteRegisteredObjects(
  keys: ReadonlyArray<string | null | undefined>,
  storage: Pick<StorageGateway, "delete">,
): Promise<boolean> {
  const unique = [...new Set(keys.filter((key): key is string => typeof key === "string" && key.length > 0))];
  let complete = true;
  for (const key of unique) {
    try {
      await storage.delete(key, AbortSignal.timeout(DELETE_TIMEOUT_MS));
    } catch {
      complete = false;
    }
  }
  return complete;
}

/** Identifiers interpolated into derived object keys must never carry path syntax. */
export function isSafeKeySegment(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

/** Mirrors the per-attempt output key written by the conversion processor. */
export function conversionAttemptOutputKey(organizationId: string, conversionId: string, attemptToken: string): string | null {
  if (![organizationId, conversionId, attemptToken].every(isSafeKeySegment)) return null;
  return `organizations/${organizationId}/conversion-outputs/${conversionId}/${attemptToken}.pdf`;
}

/** Mirrors the per-attempt archive key written by the batch packager. */
export function batchAttemptArchiveKey(organizationId: string, batchId: string, attemptToken: string): string | null {
  if (![organizationId, batchId, attemptToken].every(isSafeKeySegment)) return null;
  return `organizations/${organizationId}/batch-archives/${batchId}/${attemptToken}/uno-lote-${batchId}.zip`;
}
