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

export function billingProviderConfigured(environment: Record<string, string | undefined> = process.env): boolean {
  return Boolean(
    environment.STRIPE_SECRET_KEY?.trim() &&
    environment.STRIPE_WEBHOOK_SECRET?.trim() &&
    environment.STRIPE_PRICE_STARTER?.trim() &&
    environment.STRIPE_PRICE_PRO?.trim() &&
    environment.STRIPE_PRICE_BUSINESS?.trim(),
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
const PUBLISHABLE_KEY_FORMAT = /^pk_(test|live)_[A-Za-z0-9]{10,}$/;

export type StripeMode = "live" | "test";
export type PublishableKeyReason = "ok" | "missing" | "malformed" | "mode_mismatch" | "billing_not_configured";

/** Why the checkout can or cannot take a card. Never carries the secret key, only its mode. */
export type PublishableKeyStatus = {
  /** The publishable key (public by design), or null when the checkout cannot use it. */
  key: string | null;
  reason: PublishableKeyReason;
  secretMode: StripeMode | null;
  publishableMode: StripeMode | null;
};

function secretKeyMode(secret: string): StripeMode | null {
  if (/^(sk|rk)_live_/.test(secret)) return "live";
  if (/^(sk|rk)_test_/.test(secret)) return "test";
  return null;
}

function publishableKeyCheck(environment: Record<string, string | undefined>): Omit<PublishableKeyStatus, "reason"> & { reason: Exclude<PublishableKeyReason, "billing_not_configured"> } {
  const value = environment[PUBLISHABLE_KEY_VARIABLE]?.trim() ?? "";
  const secret = environment.STRIPE_SECRET_KEY?.trim() ?? "";
  const secretMode = secret ? secretKeyMode(secret) : null;
  if (!value) return { key: null, reason: "missing", secretMode, publishableMode: null };
  if (!PUBLISHABLE_KEY_FORMAT.test(value)) return { key: null, reason: "malformed", secretMode, publishableMode: null };
  const publishableMode: StripeMode = value.startsWith("pk_live_") ? "live" : "test";
  if (secret && secretMode !== publishableMode) return { key: null, reason: "mode_mismatch", secretMode, publishableMode };
  return { key: value, reason: "ok", secretMode, publishableMode };
}

/**
 * The Stripe publishable key for the Payment Element (NEX-52), or null when it
 * is missing, malformed or from another mode than the secret key (test vs live).
 * Read with a dynamic lookup on the server so the value in force at runtime is
 * used even if the image was built without it (Next.js only inlines literal
 * `process.env.NEXT_PUBLIC_*` references at build time).
 */
export function stripePublishableKey(environment: Record<string, string | undefined> = process.env): string | null {
  return publishableKeyCheck(environment).key;
}

/**
 * Whether the own checkout can take a card in this installation and, if not,
 * why: Stripe itself not configured, or the publishable key missing, malformed
 * or in another mode than the secret key. Only modes leave this function, never
 * key values other than the (public) publishable key.
 */
export function stripePublishableKeyStatus(environment: Record<string, string | undefined> = process.env): PublishableKeyStatus {
  const check = publishableKeyCheck(environment);
  if (!billingProviderConfigured(environment)) return { ...check, key: null, reason: "billing_not_configured" };
  return check;
}

/** What a platform admin reads to fix the checkout (pt-BR), with variable names and modes only. */
export function publishableKeyFix(status: PublishableKeyStatus): string {
  const expected = status.secretMode === "test" ? "pk_test_" : "pk_live_";
  switch (status.reason) {
    case "ok":
      return `Configurada (modo ${status.publishableMode ?? "desconhecido"}, igual à chave secreta).`;
    case "billing_not_configured":
      return "Cobrança não configurada: defina STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET e os três STRIPE_PRICE_* no serviço uno.";
    case "missing":
      return `Ausente: defina ${PUBLISHABLE_KEY_VARIABLE}=${expected}… no serviço uno e implante de novo.`;
    case "malformed":
      return `Inválida: ${PUBLISHABLE_KEY_VARIABLE} precisa ser a chave publicável (${expected}…) da mesma conta, não a secreta. Corrija no serviço uno.`;
    case "mode_mismatch":
      return status.secretMode
        ? `Modo diferente: a secreta é ${status.secretMode} e a pública é ${status.publishableMode ?? "desconhecida"}. Use a ${expected}… da mesma conta no serviço uno.`
        : `Modo diferente: a chave secreta não é sk_live_/sk_test_, então a pública (${status.publishableMode ?? "desconhecida"}) não pode ser conferida. Revise STRIPE_SECRET_KEY no serviço uno.`;
  }
}

let unusableKeyReported = false;

/**
 * The checkout's publishable key status, logging once per process when the key
 * cannot be used: {"event":"billing.config.publishable_key_unusable",...},
 * with the reason and modes only (no values).
 */
export function checkoutPublishableKeyStatus(environment: Record<string, string | undefined> = process.env): PublishableKeyStatus {
  const status = stripePublishableKeyStatus(environment);
  if (status.reason !== "ok" && !unusableKeyReported) {
    unusableKeyReported = true;
    console.warn(JSON.stringify({ event: "billing.config.publishable_key_unusable", reason: status.reason, secretMode: status.secretMode, publishableMode: status.publishableMode }));
  }
  return status;
}
