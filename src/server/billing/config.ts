import { appUrl, requiredEnv } from "@/lib/env";
import { publicPlans } from "@/lib/public-plans";
import type { PublicBillingPlan, PaidPlanId } from "@/lib/billing-model";

export const PAID_PLAN_IDS: readonly PaidPlanId[] = ["STARTER", "PRO", "BUSINESS"];

export function stripePriceId(planId: PaidPlanId): string {
  return requiredEnv(`STRIPE_PRICE_${planId}`);
}

/**
 * The optional first-month discount coupon for a plan, created by
 * `pnpm stripe:setup` when the plan has a promo. Absent means no discount is
 * applied at checkout, so billing keeps working before the coupons exist.
 */
export function stripeCouponId(planId: PaidPlanId): string | null {
  return process.env[`STRIPE_COUPON_${planId}`]?.trim() || null;
}

/** The add-on is optional: billing works without it and the add-on is simply not offered. */
export function apiAddonConfigured(): boolean {
  return billingProviderConfigured() && Boolean(process.env.STRIPE_PRICE_API_ADDON?.trim());
}

/** The add-on price id, or null when the add-on is not configured in this installation. */
export function apiAddonPriceId(): string | null {
  return process.env.STRIPE_PRICE_API_ADDON?.trim() || null;
}

export function publicBillingPlans(): PublicBillingPlan[] {
  return publicPlans();
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

const PUBLISHABLE_KEY_VARIABLE = "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY";

/**
 * The Stripe publishable key for the Payment Element (NEX-52), or null when it
 * is missing, malformed or from another mode than the secret key (test vs live).
 * Read with a dynamic lookup on the server so the value in force at runtime is
 * used even if the image was built without it (Next.js only inlines literal
 * `process.env.NEXT_PUBLIC_*` references at build time).
 */
export function stripePublishableKey(environment: Record<string, string | undefined> = process.env): string | null {
  const value = environment[PUBLISHABLE_KEY_VARIABLE]?.trim();
  if (!value || !/^pk_(test|live)_[A-Za-z0-9]{10,}$/.test(value)) return null;
  const secret = environment.STRIPE_SECRET_KEY?.trim() ?? "";
  const mode = value.startsWith("pk_live_") ? "live" : "test";
  if (secret && !(secret.startsWith(`sk_${mode}_`) || secret.startsWith(`rk_${mode}_`))) return null;
  return value;
}
