import { z } from "zod";

export const planIdSchema = z.enum(["FREE", "STARTER", "PRO", "BUSINESS"]);
export type PlanId = z.infer<typeof planIdSchema>;

export type PlanDefinition = {
  name: string;
  price: number;
  /** The recurring price, charged from the second month on. */
  priceBrlCents: number;
  /** The promotional price of the first month (equal to priceBrlCents when there is no promo). */
  firstMonthPriceBrlCents: number;
  monthlyLimit: number;
  maxFileMB: number;
  batchLimit: number;
  retentionDays: number;
  /** API and webhooks included in the plan itself. No plan includes them: they come from the API add-on. */
  api: boolean;
  rateLimit: number;
};

/** A paid plan whose first month is cheaper than the recurring price. */
export function hasFirstMonthPromo(plan: PlanDefinition): boolean {
  return plan.priceBrlCents > 0 && plan.firstMonthPriceBrlCents < plan.priceBrlCents;
}

export type ApiAddonDefinition = {
  id: "API";
  name: string;
  priceBrlCents: number;
};

// Recurring prices (priceBrlCents) with a cheaper first month (firstMonthPriceBrlCents),
// in the style of the competitor: the landing shows the first month, then the normal price.
const DEFAULT_PLANS: Record<PlanId, PlanDefinition> = {
  FREE: { name: "Free", price: 0, priceBrlCents: 0, firstMonthPriceBrlCents: 0, monthlyLimit: 10, maxFileMB: 5, batchLimit: 1, retentionDays: 7, api: false, rateLimit: 30 },
  STARTER: { name: "Starter", price: 19, priceBrlCents: 1_900, firstMonthPriceBrlCents: 999, monthlyLimit: 300, maxFileMB: 20, batchLimit: 50, retentionDays: 30, api: false, rateLimit: 30 },
  PRO: { name: "Pro", price: 49, priceBrlCents: 4_900, firstMonthPriceBrlCents: 1_599, monthlyLimit: 2_000, maxFileMB: 50, batchLimit: 100, retentionDays: 90, api: false, rateLimit: 60 },
  BUSINESS: { name: "Business", price: 139, priceBrlCents: 13_900, firstMonthPriceBrlCents: 2_990, monthlyLimit: 10_000, maxFileMB: 100, batchLimit: 500, retentionDays: 180, api: false, rateLimit: 120 },
};

const DEFAULT_API_ADDON: ApiAddonDefinition = { id: "API", name: "API", priceBrlCents: 5_000 };

const CONFIGURABLE_NUMBERS = {
  PRICE_BRL_CENTS: { key: "priceBrlCents", min: 0, max: 100_000_000 },
  FIRST_MONTH_PRICE_BRL_CENTS: { key: "firstMonthPriceBrlCents", min: 0, max: 100_000_000 },
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
      const key = definition.key as keyof Pick<PlanDefinition, "priceBrlCents" | "firstMonthPriceBrlCents" | "monthlyLimit" | "maxFileMB" | "batchLimit" | "retentionDays" | "rateLimit">;
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
    if (planId === "FREE" && configured.firstMonthPriceBrlCents !== 0) throw new PlanConfigurationError("UNO_PLAN_FREE_FIRST_MONTH_PRICE_BRL_CENTS");
    // The first month can only be a discount, never a surcharge over the recurring price.
    if (configured.firstMonthPriceBrlCents > configured.priceBrlCents) throw new PlanConfigurationError(`UNO_PLAN_${planId}_FIRST_MONTH_PRICE_BRL_CENTS`);
    return [planId, Object.freeze(configured)];
  })) as Record<PlanId, PlanDefinition>;
}

/**
 * The paid add-on that unlocks API keys, the public API and webhooks on top of
 * any paid plan. The price must be positive: it is charged by its own subscription.
 */
export function getApiAddon(environment: NodeJS.ProcessEnv = process.env): ApiAddonDefinition {
  return Object.freeze({
    ...DEFAULT_API_ADDON,
    priceBrlCents: configuredInteger(environment, "UNO_API_ADDON_PRICE_BRL_CENTS", DEFAULT_API_ADDON.priceBrlCents, 1, 100_000_000),
  });
}

/** pt-BR currency with cents, always derived from the integer amount: 999 → "R$ 9,99". */
export function formatBrlCents(cents: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
}

// Presentation defaults are safe to bundle. Authorization and quota paths use
// getPlanCatalog(), which validates runtime overrides lazily.
export const PLANS = Object.freeze(DEFAULT_PLANS);
export const API_ADDON = Object.freeze(DEFAULT_API_ADDON);
