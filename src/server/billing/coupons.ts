import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { billingCheckoutIntents, coupons, getDb, subscriptions, type UnoDatabase } from "@/db";
import type { CouponPreview, PaidPlanId } from "@/lib/billing-model";
import { positiveIntegerEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { formatBrlCents, getPlanCatalog, hasFirstMonthPromo } from "@/lib/plans";
import { enforceRateLimit } from "@/server/rate-limit";

import { billingProviderConfigured, stripeCouponId } from "./config";
import { getBillingProvider, type BillingProvider, type PromotionCodeSnapshot } from "./stripe";

export const COUPON_CODE = /^[A-Z0-9_-]{3,40}$/;

/**
 * One answer for every refusal (unknown, inactive, expired, exhausted, wrong
 * plan, unavailable), so the response never tells whether a code exists. The
 * specific reason only goes to the server log. The organization's own prior
 * use is the exception: it reveals nothing that organization does not know.
 */
export const COUPON_MESSAGES = {
  invalid: "Cupom inválido ou indisponível para este plano.",
  alreadyUsed: "Este cupom já foi usado nesta conta.",
} as const;

type RejectionReason = "malformed" | "unknown" | "inactive" | "expired" | "exhausted" | "wrong_plan" | "billing_unavailable" | "provider_invalid" | "already_used";

/** Codes are case-insensitive for the buyer and stored upper case. */
export function normalizeCouponCode(value: string): string {
  return value.trim().toUpperCase();
}

export type QuoteDependencies = {
  database: Pick<UnoDatabase, "select">;
  provider: BillingProvider;
  now(): Date;
};

function defaults(): QuoteDependencies {
  return { database: getDb(), provider: getBillingProvider(), now: () => new Date() };
}

type Discount = { percentOff: number | null; amountOff: number | null; duration: "once" | "forever" | "repeating"; durationInMonths: number | null };

/** Price after a coupon, never negative. Stripe rounds a percentage to the nearest cent. */
export function discountedPrice(priceBrlCents: number, discount: Pick<Discount, "percentOff" | "amountOff">): number {
  if (discount.percentOff !== null) return Math.max(0, priceBrlCents - Math.round((priceBrlCents * discount.percentOff) / 100));
  return Math.max(0, priceBrlCents - (discount.amountOff ?? 0));
}

/** Months the coupon discounts: null means every month. */
function discountedMonths(discount: Discount): number | null {
  if (discount.duration === "forever") return null;
  if (discount.duration === "repeating") return Math.max(1, discount.durationInMonths ?? 1);
  return 1;
}

export function couponLabel(discount: Discount): string {
  const amount = discount.percentOff !== null ? `${discount.percentOff}% de desconto` : `${formatBrlCents(discount.amountOff ?? 0)} de desconto`;
  const months = discountedMonths(discount);
  if (months === null) return `${amount} em todas as mensalidades`;
  if (months === 1) return `${amount} no 1º mês`;
  return `${amount} nos ${months} primeiros meses`;
}

/** What the server decided to charge, and with which single Stripe discount. */
export type CheckoutQuote = {
  preview: CouponPreview;
  /** The Stripe Promotion Code to apply when the coupon won. */
  promotionCodeId: string | null;
  /** Our coupons.id when the coupon won. */
  couponId: string | null;
  /** The first-month promo coupon when it won (or no code was given). */
  firstMonthCouponId: string | null;
  /** The normalized code the buyer typed, if any. */
  code: string | null;
};

function baseQuote(planId: PaidPlanId, code: string | null, message: string, valid: boolean): CheckoutQuote {
  const plan = getPlanCatalog()[planId];
  // The promo only reaches the invoice when its Stripe coupon is configured.
  const firstMonthCouponId = hasFirstMonthPromo(plan) ? stripeCouponId(planId) : null;
  return {
    preview: {
      valid,
      message,
      code,
      appliedDiscount: firstMonthCouponId ? "first_month" : "none",
      firstPaymentBrlCents: firstMonthCouponId ? plan.firstMonthPriceBrlCents : plan.priceBrlCents,
      recurringBrlCents: plan.priceBrlCents,
      regularBrlCents: plan.priceBrlCents,
      discountedMonths: firstMonthCouponId ? 1 : 0,
      label: null,
    },
    promotionCodeId: null,
    couponId: null,
    firstMonthCouponId,
    code,
  };
}

/** The plan's price with no coupon: the first-month promo when its Stripe coupon is configured, else the regular price. */
export function listPriceQuote(planId: PaidPlanId): CouponPreview {
  return baseQuote(planId, null, "", true).preview;
}

function rejected(planId: PaidPlanId, code: string | null, reason: RejectionReason): CheckoutQuote {
  // The reason is for operators only; the buyer always gets the same message.
  console.log(JSON.stringify({ event: "billing.coupon.rejected", reason, planId, code }));
  return baseQuote(planId, code, reason === "already_used" ? COUPON_MESSAGES.alreadyUsed : COUPON_MESSAGES.invalid, false);
}

function liveRejection(promotion: PromotionCodeSnapshot | null, now: Date): RejectionReason | null {
  if (!promotion || !promotion.active || !promotion.coupon || !promotion.coupon.valid) return "provider_invalid";
  if (promotion.expiresAt && promotion.expiresAt <= now) return "expired";
  if (promotion.maxRedemptions !== null && promotion.timesRedeemed >= promotion.maxRedemptions) return "exhausted";
  if (promotion.coupon.percentOff === null && (promotion.coupon.amountOff === null || promotion.coupon.currency !== "brl")) return "provider_invalid";
  return null;
}

/** The organization already paid with this coupon, or carries it now: one use per organization. */
async function usedByOrganization(database: QuoteDependencies["database"], organizationId: string, couponId: string): Promise<boolean> {
  const paid = await database.select({ id: billingCheckoutIntents.id }).from(billingCheckoutIntents).where(and(
    eq(billingCheckoutIntents.organizationId, organizationId),
    eq(billingCheckoutIntents.couponId, couponId),
    eq(billingCheckoutIntents.status, "COMPLETED"),
  )).limit(1);
  if (paid[0]) return true;
  const carried = await database.select({ id: subscriptions.id }).from(subscriptions).where(and(
    eq(subscriptions.organizationId, organizationId),
    eq(subscriptions.appliedCouponId, couponId),
  )).limit(1);
  return Boolean(carried[0]);
}

/**
 * Prices a paid plan with an optional coupon. Stripe Checkout takes a single
 * discount, so (owner decision, NEX-51) the coupon and the first-month promo
 * are both computed and the one with the LOWER first payment wins; on a tie the
 * coupon wins only if it also discounts later months. The coupon's live state
 * (active, expiry, redemptions, amount) comes from Stripe; plan applicability
 * comes from our own record. Never trusts a client-side price.
 */
export async function quoteCheckout(planId: PaidPlanId, rawCode: string | null | undefined, organizationId: string, dependencies: QuoteDependencies = defaults()): Promise<CheckoutQuote> {
  const plan = getPlanCatalog()[planId];
  if (rawCode === null || rawCode === undefined || rawCode.trim() === "") return baseQuote(planId, null, "", true);
  const code = normalizeCouponCode(rawCode);
  if (!COUPON_CODE.test(code)) return rejected(planId, null, "malformed");
  const now = dependencies.now();
  const rows = await dependencies.database.select().from(coupons).where(eq(coupons.code, code)).limit(1);
  const coupon = rows[0];
  if (!coupon) return rejected(planId, code, "unknown");
  if (!coupon.active) return rejected(planId, code, "inactive");
  if (await usedByOrganization(dependencies.database, organizationId, coupon.id)) return rejected(planId, code, "already_used");
  if (coupon.expiresAt && coupon.expiresAt <= now) return rejected(planId, code, "expired");
  if (coupon.planIds.length > 0 && !coupon.planIds.includes(planId)) return rejected(planId, code, "wrong_plan");
  if (!billingProviderConfigured()) return rejected(planId, code, "billing_unavailable");
  let promotion: PromotionCodeSnapshot | null;
  try {
    promotion = await dependencies.provider.retrievePromotionCode(coupon.stripePromotionCodeId);
  } catch {
    throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
  }
  const reason = liveRejection(promotion, now);
  if (reason || !promotion?.coupon) return rejected(planId, code, reason ?? "provider_invalid");

  const live: Discount = promotion.coupon;
  const regular = plan.priceBrlCents;
  const months = discountedMonths(live);
  const couponFirst = discountedPrice(regular, live);
  const couponSecond = months === null || months >= 2 ? couponFirst : regular;
  const base = baseQuote(planId, code, "", true);
  const promoFirst = base.preview.firstPaymentBrlCents;
  const couponWins = couponFirst < promoFirst || (couponFirst === promoFirst && couponSecond < regular);
  const label = couponLabel(live);
  if (!couponWins) {
    return {
      ...base,
      preview: {
        ...base.preview,
        label,
        message: base.preview.appliedDiscount === "first_month"
          ? `Promoção do 1º mês mantida, que já é melhor que o cupom ${code}.`
          : `O cupom ${code} não reduz o valor deste plano.`,
      },
    };
  }
  return {
    preview: {
      valid: true,
      message: `Cupom ${code} aplicado.`,
      code,
      appliedDiscount: "coupon",
      firstPaymentBrlCents: couponFirst,
      recurringBrlCents: couponSecond,
      regularBrlCents: regular,
      discountedMonths: months,
      label,
    },
    promotionCodeId: promotion.id,
    couponId: coupon.id,
    firstMonthCouponId: null,
    code,
  };
}

/**
 * Per-user limit on coupon lookups (preview and checkout with a code), so codes
 * cannot be enumerated. 10 per minute by default.
 */
export async function enforceCouponRateLimit(userId: string): Promise<void> {
  await enforceRateLimit({ namespace: "billing-coupon", identifier: userId, limit: positiveIntegerEnv("UNO_COUPON_RATE_LIMIT", 10) });
}

/** The client address as the app reads it elsewhere (first X-Forwarded-For hop, then X-Real-IP). */
export function clientAddress(headers: Headers): string {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip")?.trim() || "unknown";
}

/**
 * Per-address limit on coupon lookups, on top of the per-user one, so many
 * throwaway accounts behind one address cannot enumerate codes. 30 per minute
 * by default. The address is hashed before it becomes a key.
 */
export async function enforceCouponIpRateLimit(headers: Headers): Promise<void> {
  const identifier = createHash("sha256").update(clientAddress(headers)).digest("hex");
  await enforceRateLimit({ namespace: "billing-coupon-ip", identifier, limit: positiveIntegerEnv("UNO_COUPON_IP_RATE_LIMIT", 30) });
}

/** POST billing/coupon/preview: the server-side price of a plan with a coupon for this organization. */
export async function previewCoupon(planId: PaidPlanId, code: string, organizationId: string, dependencies: QuoteDependencies = defaults()): Promise<CouponPreview> {
  return (await quoteCheckout(planId, code, organizationId, dependencies)).preview;
}
