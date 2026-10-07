/**
 * Retention settings are security relevant: a typo must stop the worker instead
 * of silently changing how long customer artifacts or leases live.
 */
export class RetentionConfigError extends Error {
  readonly code = "invalid_retention_config";

  constructor(readonly variable: string) {
    super(`Invalid retention configuration: ${variable}.`);
    this.name = "RetentionConfigError";
  }
}

export type RetentionConfig = {
  /** Delay between two maintenance cycles. */
  intervalMs: number;
  /** Maximum records claimed per kind in one cycle. */
  batchSize: number;
  /** Lifetime of a retention claim; an unfinished deletion is retried after it. */
  leaseMs: number;
  /** Extra wait after the last signed PUT validity before an unused upload is removed. */
  uploadGraceMs: number;
  /** Minimum age of an abandoned private engine workspace before it is removed. */
  workspaceMaxAgeMs: number;
};

type Bounds = { fallback: number; minimum: number; maximum: number };

const BOUNDS = {
  UNO_RETENTION_INTERVAL_MS: { fallback: 60_000, minimum: 1_000, maximum: 3_600_000 },
  UNO_RETENTION_BATCH_SIZE: { fallback: 50, minimum: 1, maximum: 500 },
  UNO_RETENTION_LEASE_MS: { fallback: 300_000, minimum: 10_000, maximum: 3_600_000 },
  UNO_RETENTION_UPLOAD_GRACE_MS: { fallback: 900_000, minimum: 60_000, maximum: 86_400_000 },
  // The engine hard deadline is 120 s; never reclaim a workspace younger than 5 min.
  UNO_ENGINE_TMP_MAX_AGE_MS: { fallback: 3_600_000, minimum: 300_000, maximum: 604_800_000 },
} as const satisfies Record<string, Bounds>;

type Variable = keyof typeof BOUNDS;
type Environment = Record<string, string | undefined>;

function boundedInteger(environment: Environment, variable: Variable): number {
  const bounds: Bounds = BOUNDS[variable];
  const raw = environment[variable];
  if (raw === undefined || raw.trim() === "") return bounds.fallback;
  if (!/^\d{1,15}$/.test(raw.trim())) throw new RetentionConfigError(variable);
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < bounds.minimum || value > bounds.maximum) {
    throw new RetentionConfigError(variable);
  }
  return value;
}

export function readRetentionConfig(environment: Environment = process.env): RetentionConfig {
  return {
    intervalMs: boundedInteger(environment, "UNO_RETENTION_INTERVAL_MS"),
    batchSize: boundedInteger(environment, "UNO_RETENTION_BATCH_SIZE"),
    leaseMs: boundedInteger(environment, "UNO_RETENTION_LEASE_MS"),
    uploadGraceMs: boundedInteger(environment, "UNO_RETENTION_UPLOAD_GRACE_MS"),
    workspaceMaxAgeMs: boundedInteger(environment, "UNO_ENGINE_TMP_MAX_AGE_MS"),
  };
}
