import { randomUUID } from "node:crypto";

import { getDb } from "@/db";
import { recoverAbandonedEngineWorkspaces } from "@/engine/isolated";
import { getStorage } from "@/server/storage";

import { cleanupExpiredBatches } from "./batches";
import { readRetentionConfig, type RetentionConfig } from "./config";
import { cleanupExpiredConversions } from "./conversions";
import type { RetentionDependencies, RetentionSummary } from "./shared";
import { cleanupExpiredUploadIntents } from "./uploads";

export { cleanupExpiredBatches } from "./batches";
export { readRetentionConfig, RetentionConfigError, type RetentionConfig } from "./config";
export { cleanupExpiredConversions, REMOVED_FILE_NAME } from "./conversions";
export { collectOrphanCandidate, type OrphanCandidate, type OrphanDecision } from "./orphans";
export type { RetentionDependencies, RetentionSummary } from "./shared";
export { cleanupExpiredUploadIntents } from "./uploads";

export type RetentionCycleResult = {
  batches: RetentionSummary;
  conversions: RetentionSummary;
  uploadIntents: RetentionSummary;
  workspaces: number;
};

export function retentionDependencies(config: Pick<RetentionConfig, "leaseMs">): RetentionDependencies {
  return {
    database: getDb(),
    storage: getStorage(),
    randomId: randomUUID,
    now: () => new Date(),
    leaseMs: config.leaseMs,
  };
}

/**
 * One bounded maintenance pass. Batches run first so every aggregate is closed
 * before its children are tombstoned. Each step is independent: a failure in
 * one is reported by rethrowing after the others had their chance to run.
 */
export async function runRetentionCycle(
  config: RetentionConfig = readRetentionConfig(),
  dependencies: RetentionDependencies = retentionDependencies(config),
  options: { workspaceRoot?: string } = {},
): Promise<RetentionCycleResult> {
  const failures: unknown[] = [];
  const attempt = async <T>(operation: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      failures.push(error);
      return fallback;
    }
  };
  const idle = (): RetentionSummary => ({ deleted: 0, deferred: 0, failed: 0 });
  const result: RetentionCycleResult = {
    batches: await attempt(() => cleanupExpiredBatches(dependencies, config.batchSize), idle()),
    conversions: await attempt(() => cleanupExpiredConversions(dependencies, config.batchSize), idle()),
    uploadIntents: await attempt(() => cleanupExpiredUploadIntents(dependencies, {
      limit: config.batchSize,
      graceMs: config.uploadGraceMs,
    }), idle()),
    workspaces: await attempt(() => recoverAbandonedEngineWorkspaces({
      maxAgeMs: config.workspaceMaxAgeMs,
      now: dependencies.now(),
      root: options.workspaceRoot,
    }), 0),
  };
  if (failures.length) throw new Error("retention_cycle_incomplete");
  return result;
}
