import { z } from "zod";

export const planIdSchema = z.enum(["FREE", "STARTER", "PRO", "BUSINESS"]);
export type PlanId = z.infer<typeof planIdSchema>;

export type PlanDefinition = {
  name: string;
  price: number;
  priceBrlCents: number;
  monthlyLimit: number;
  maxFileMB: number;
  batchLimit: number;
  retentionDays: number;
  api: boolean;
  rateLimit: number;
};

const DEFAULT_PLANS: Record<PlanId, PlanDefinition> = {
  FREE: { name: "Free", price: 0, priceBrlCents: 0, monthlyLimit: 10, maxFileMB: 5, batchLimit: 1, retentionDays: 7, api: false, rateLimit: 30 },
  STARTER: { name: "Starter", price: 29, priceBrlCents: 2_900, monthlyLimit: 300, maxFileMB: 20, batchLimit: 50, retentionDays: 30, api: false, rateLimit: 30 },
  PRO: { name: "Pro", price: 59, priceBrlCents: 5_900, monthlyLimit: 2_000, maxFileMB: 50, batchLimit: 100, retentionDays: 90, api: true, rateLimit: 60 },
  BUSINESS: { name: "Business", price: 149, priceBrlCents: 14_900, monthlyLimit: 10_000, maxFileMB: 100, batchLimit: 500, retentionDays: 180, api: true, rateLimit: 120 },
};

const CONFIGURABLE_NUMBERS = {
  PRICE_BRL_CENTS: { key: "priceBrlCents", min: 0, max: 100_000_000 },
  MONTHLY_LIMIT: { key: "monthlyLimit", min: 0, max: 100_000_000 },
  MAX_FILE_MB: { key: "maxFileMB", min: 1, max: 100 },
  BATCH_LIMIT: { key: "batchLimit", min: 1, max: 10_000 },
  RETENTION_DAYS: { key: "retentionDays", min: 1, max: 3_650 },
  RATE_LIMIT: { key: "rateLimit", min: 0, max: 1_000_000 },
} as const;

export class PlanConfigurationError extends Error {
  constructor(readonly variable: string) {
    super(`Invalid plan configuration: ${variable}`);
    this.name = "PlanConfigurationError";
  }
}

function configuredInteger(
  environment: NodeJS.ProcessEnv,
  variable: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = environment[variable];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new PlanConfigurationError(variable);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new PlanConfigurationError(variable);
  return parsed;
}

export function getPlanCatalog(environment: NodeJS.ProcessEnv = process.env): Record<PlanId, PlanDefinition> {
  return Object.fromEntries(planIdSchema.options.map((planId) => {
    const defaults = DEFAULT_PLANS[planId];
    const configured = { ...defaults };
    for (const [suffix, definition] of Object.entries(CONFIGURABLE_NUMBERS)) {
      const key = definition.key as keyof Pick<PlanDefinition, "priceBrlCents" | "monthlyLimit" | "maxFileMB" | "batchLimit" | "retentionDays" | "rateLimit">;
      configured[key] = configuredInteger(
        environment,
        `UNO_PLAN_${planId}_${suffix}`,
        defaults[key],
        definition.min,
        definition.max,
      );
    }
    configured.price = configured.priceBrlCents / 100;
    if (planId === "FREE" && configured.priceBrlCents !== 0) throw new PlanConfigurationError("UNO_PLAN_FREE_PRICE_BRL_CENTS");
    return [planId, Object.freeze(configured)];
  })) as Record<PlanId, PlanDefinition>;
}

// Presentation defaults are safe to bundle. Authorization and quota paths use
// getPlanCatalog(), which validates runtime overrides lazily.
export const PLANS = Object.freeze(DEFAULT_PLANS);
