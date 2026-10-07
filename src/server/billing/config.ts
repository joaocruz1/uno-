import { appUrl, requiredEnv } from "@/lib/env";
import { getPlanCatalog, type PlanId } from "@/lib/plans";
import type { PublicBillingPlan, PaidPlanId } from "@/lib/billing-model";

export const PAID_PLAN_IDS: readonly PaidPlanId[] = ["STARTER", "PRO", "BUSINESS"];

export function stripePriceId(planId: PaidPlanId): string {
  return requiredEnv(`STRIPE_PRICE_${planId}`);
}

export function publicBillingPlans(): PublicBillingPlan[] {
  const plans = getPlanCatalog();
  return (Object.keys(plans) as PlanId[]).map((id) => {
    const plan = plans[id];
    return {
      id,
      name: plan.name,
      priceBrlCents: plan.priceBrlCents,
      monthlyLimit: plan.monthlyLimit,
      maxFileMB: plan.maxFileMB,
      batchLimit: plan.batchLimit,
      retentionDays: plan.retentionDays,
      api: plan.api,
      rateLimit: plan.rateLimit,
    };
  });
}

export function billingProviderConfigured(): boolean {
  return Boolean(
    process.env.STRIPE_SECRET_KEY?.trim() &&
    process.env.STRIPE_WEBHOOK_SECRET?.trim() &&
    process.env.STRIPE_PRICE_STARTER?.trim() &&
    process.env.STRIPE_PRICE_PRO?.trim() &&
    process.env.STRIPE_PRICE_BUSINESS?.trim(),
  );
}

export function billingUrls() {
  const base = appUrl().replace(/\/$/, "");
  return {
    success: `${base}/dashboard/billing?checkout=success`,
    cancel: `${base}/dashboard/billing?checkout=cancelled`,
    portalReturn: `${base}/dashboard/billing`,
  };
}
