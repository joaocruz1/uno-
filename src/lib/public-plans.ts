import type { PublicBillingPlan } from "./billing-model";
import { getPlanCatalog, type PlanId } from "./plans";

/** The plan catalog as shown to buyers: prices and limits only, never provider ids. */
export function publicPlans(environment: NodeJS.ProcessEnv = process.env): PublicBillingPlan[] {
  const plans = getPlanCatalog(environment);
  return (Object.keys(plans) as PlanId[]).map((id) => {
    const plan = plans[id];
    return {
      id,
      name: plan.name,
      priceBrlCents: plan.priceBrlCents,
      firstMonthPriceBrlCents: plan.firstMonthPriceBrlCents,
      monthlyLimit: plan.monthlyLimit,
      maxFileMB: plan.maxFileMB,
      batchLimit: plan.batchLimit,
      retentionDays: plan.retentionDays,
      api: plan.api,
      rateLimit: plan.rateLimit,
    };
  });
}
