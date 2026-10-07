import { and, asc, eq, isNull, lte } from "drizzle-orm";

import { conversions, uploadIntents } from "@/db";

import { emptySummary, type RetentionDependencies, type RetentionSummary } from "./shared";

const DELETE_TIMEOUT_MS = 15_000;

/**
 * Removes upload intents that were never consumed by a conversion, together
 * with their staged object. The intent row is the provable owner of the key;
 * it is re-checked under lock after the last signed PUT validity plus a grace
 * period, so neither a late PUT nor a concurrent consumption can race it.
 * Consumed intents are left alone here: their staged object is removed with
 * the conversion that owns it.
 */
export async function cleanupExpiredUploadIntents(
  dependencies: Pick<RetentionDependencies, "database" | "storage" | "now">,
  options: { limit: number; graceMs: number },
): Promise<RetentionSummary> {
  if (!Number.isSafeInteger(options.graceMs) || options.graceMs < 0) throw new RangeError("graceMs must be a non-negative integer");
  const cutoff = () => new Date(dependencies.now().getTime() - options.graceMs);
  const candidates = await dependencies.database.select({
    id: uploadIntents.id,
    organizationId: uploadIntents.organizationId,
  }).from(uploadIntents).where(and(
    isNull(uploadIntents.consumedAt),
    lte(uploadIntents.expiresAt, cutoff()),
  )).orderBy(asc(uploadIntents.expiresAt), asc(uploadIntents.id)).limit(Math.max(1, Math.min(500, Math.trunc(options.limit))));

  const summary = emptySummary();
  for (const candidate of candidates) {
    try {
      const removed = await dependencies.database.transaction(async (transaction) => {
        const rows = await transaction.select().from(uploadIntents).where(and(
          eq(uploadIntents.organizationId, candidate.organizationId),
          eq(uploadIntents.id, candidate.id),
        )).limit(1).for("update");
        const intent = rows[0];
        if (!intent || intent.consumedAt || intent.expiresAt.getTime() > cutoff().getTime()) return false;
        const owners = await transaction.select({ id: conversions.id }).from(conversions).where(and(
          eq(conversions.organizationId, intent.organizationId),
          eq(conversions.uploadIntentId, intent.id),
        )).limit(1);
        if (owners[0]) return false;
        // The lock is held across the provider call: a failed delete rolls the
        // row back so the key stays tracked, and a repeated delete is harmless.
        await dependencies.storage.delete(intent.objectKey, AbortSignal.timeout(DELETE_TIMEOUT_MS));
        await transaction.delete(uploadIntents).where(and(
          eq(uploadIntents.organizationId, intent.organizationId),
          eq(uploadIntents.id, intent.id),
        ));
        return true;
      });
      if (removed) summary.deleted += 1;
    } catch {
      summary.failed += 1;
    }
  }
  return summary;
}
