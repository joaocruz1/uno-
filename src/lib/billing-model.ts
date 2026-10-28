import { z } from "zod";

import { planIdSchema } from "./plans";

export const subscriptionStatusSchema = z.enum([
  "INCOMPLETE",
  "TRIALING",
  "ACTIVE",
  "PAST_DUE",
  "CANCELED",
  "UNPAID",
  "PAUSED",
]);

export const paidPlanIdSchema = z.enum(["STARTER", "PRO", "BUSINESS"]);

export const publicPlanSchema = z.object({
  id: planIdSchema,
  name: z.string().min(1),
  priceBrlCents: z.number().int().nonnegative(),
  firstMonthPriceBrlCents: z.number().int().nonnegative(),
  monthlyLimit: z.number().int().nonnegative(),
  maxFileMB: z.number().int().positive(),
  batchLimit: z.number().int().positive(),
  retentionDays: z.number().int().positive(),
  api: z.boolean(),
  rateLimit: z.number().int().nonnegative(),
});

export const apiAddonIdSchema = z.enum(["API"]);

export const apiAddonStateSchema = z.object({
  name: z.string().min(1),
  priceBrlCents: z.number().int().positive(),
  /** API, keys and webhooks are usable right now: paid plan in force and add-on paid up. */
  active: z.boolean(),
  status: subscriptionStatusSchema.nullable(),
  currentPeriodEnd: z.iso.datetime({ offset: true }).nullable(),
  /** The actor can start the add-on checkout now. */
  available: z.boolean(),
  /** The add-on is paid up but grants nothing because no paid plan is in force. */
  inactiveWithoutPaidPlan: z.boolean(),
});

/** A coupon code as typed by the buyer; the server normalizes and validates it. */
export const promotionCodeInputSchema = z.string().trim().min(1).max(64);

/** Checkout request: exactly one of a paid plan (optionally with a coupon) or the API add-on. */
export const billingCheckoutRequestSchema = z.union([
  z.object({ planId: paidPlanIdSchema, promotionCode: promotionCodeInputSchema.optional() }).strict(),
  z.object({ addon: apiAddonIdSchema }).strict(),
]);

/**
 * POST billing/subscribe answer (own checkout, NEX-52). `confirmation` says what
 * the browser does with `clientSecret`: confirm the first payment, save the card
 * for renewals when nothing is due today, or nothing (already paid). The plan is
 * only ever granted by the webhook; this answer grants nothing.
 */
export const subscribeResultSchema = z.object({
  intentId: z.string().min(1),
  confirmation: z.enum(["payment", "setup", "none"]),
  clientSecret: z.string().min(1).nullable(),
  /** What the first invoice charges today, from Stripe. */
  amountDueBrlCents: z.number().int().nonnegative(),
  /** The monthly price after the first payment. */
  recurringBrlCents: z.number().int().nonnegative(),
});

/** A card kept by Stripe on the organization's Customer: display fields only. */
export const savedCardSchema = z.object({
  id: z.string().min(1),
  brand: z.string(),
  last4: z.string().regex(/^\d{4}$/),
  expMonth: z.number().int().min(1).max(12),
  expYear: z.number().int(),
  /** The Customer's default card (charged by the add-on and new subscriptions). */
  isDefault: z.boolean(),
  /** It pays a live subscription. */
  inUse: z.boolean(),
});

export const savedCardsSchema = z.object({ cards: z.array(savedCardSchema) });

/** POST billing/payment-session: Payment Element CustomerSession plus the kept cards. */
export const paymentSessionSchema = z.object({
  customerSessionClientSecret: z.string().min(1),
  cards: z.array(savedCardSchema),
});

export const removeCardRequestSchema = z.object({ paymentMethodId: z.string().regex(/^pm_[A-Za-z0-9]{1,250}$/) }).strict();

/** POST billing/coupon/preview: price a plan with a coupon before paying (NEX-51). */
export const couponPreviewRequestSchema = z.object({ planId: paidPlanIdSchema, code: promotionCodeInputSchema }).strict();

/**
 * Server-computed price of a plan with a coupon. Stripe Checkout takes one
 * discount, so the lower first payment between the coupon and the first-month
 * promo wins (`appliedDiscount`).
 */
export const couponPreviewSchema = z.object({
  /** The code exists and can be used now (it may still lose to the first-month promo). */
  valid: z.boolean(),
  message: z.string(),
  code: z.string().nullable(),
  appliedDiscount: z.enum(["coupon", "first_month", "none"]),
  firstPaymentBrlCents: z.number().int().nonnegative(),
  /** What the second month costs. */
  recurringBrlCents: z.number().int().nonnegative(),
  /** The plan's regular monthly price. */
  regularBrlCents: z.number().int().nonnegative(),
  /** Months with the applied discount: null is every month, 0 is none. */
  discountedMonths: z.number().int().nonnegative().nullable(),
  /** Description of the coupon's discount, when the code is valid. */
  label: z.string().nullable(),
});

/**
 * GET billing/checkout-config: what the checkout needs to take a card (the
 * public Stripe key, validated by the server) and the server's price of each
 * plan without a coupon. `adminDetail` (why payment is unavailable, with the
 * fix) is only sent to platform admins.
 */
export const checkoutConfigSchema = z.object({
  publishableKey: z.string().regex(/^pk_(test|live)_[A-Za-z0-9]{10,}$/).nullable(),
  adminDetail: z.string().nullable(),
  quotes: z.object({ STARTER: couponPreviewSchema, PRO: couponPreviewSchema, BUSINESS: couponPreviewSchema }),
  /** PIX in the checkout: whether a gateway is configured, and the server's price of 30 days per plan for this organization. */
  pix: z.object({
    available: z.boolean(),
    amounts: z.object({ STARTER: z.number().int().nonnegative(), PRO: z.number().int().nonnegative(), BUSINESS: z.number().int().nonnegative() }),
  }),
});

/** POST billing/plan: swap the plan of the live card subscription. */
export const billingPlanChangeRequestSchema = z.object({ planId: paidPlanIdSchema }).strict();

/** POST billing/cancel and billing/resume: the "+ API" add-on follows the plan by default. */
export const billingCancelRequestSchema = z.object({ alsoAddon: z.boolean().optional() }).strict();

/** Without a card subscription the plan is bought through the checkout page (/checkout). */
export const billingPlanChangeResultSchema = z.union([
  z.object({ checkout: z.literal(true) }),
  z.object({
    checkout: z.literal(false),
    planId: paidPlanIdSchema,
    /** A coupon restricted to other plans was removed by the swap (its code), or null. */
    couponRemoved: z.string().nullable().optional(),
  }),
]);

export const refundIneligibleReasonSchema = z.enum([
  "no_card_subscription",
  "no_paid_invoice",
  "window_expired",
  "already_refunded",
]);

/** 7-day withdrawal refund (CDC art. 49), one per organization. */
export const refundEligibilitySchema = z.object({
  eligible: z.boolean(),
  reason: refundIneligibleReasonSchema.nullable(),
  /** End of the 7-day window counted from the first paid invoice of the plan subscription. */
  deadline: z.iso.datetime({ offset: true }).nullable(),
  /** What would be refunded now: plan and add-on invoices paid inside the window, minus refunds already made. */
  amountBrlCents: z.number().int().nonnegative(),
  /** A previous request was interrupted; requesting again finishes it. */
  inProgress: z.boolean(),
});

export const refundResultSchema = z.object({
  refundedBrlCents: z.number().int().nonnegative(),
  refundedAt: z.iso.datetime({ offset: true }),
});

export const billingManagementSchema = z.object({
  /** The actor can swap plans in-app (live card plan subscription). */
  changePlan: z.boolean(),
  /** The actor can schedule the cancellation at period end. */
  cancel: z.boolean(),
  /** A scheduled cancellation can be withdrawn. */
  resume: z.boolean(),
});

export const prepaidStateSchema = z.object({
  planId: planIdSchema,
  periodEnd: z.iso.datetime({ offset: true }),
});

export const billingStateSchema = z.object({
  planId: planIdSchema,
  effectivePlanId: planIdSchema,
  status: subscriptionStatusSchema,
  currentPeriodStart: z.iso.datetime({ offset: true }).nullable(),
  currentPeriodEnd: z.iso.datetime({ offset: true }).nullable(),
  cancelAtPeriodEnd: z.boolean(),
  checkoutAvailable: z.boolean(),
  portalAvailable: z.boolean(),
  /** The viewer is OWNER/ADMIN of the organization (buying and managing are theirs). */
  canManage: z.boolean(),
  /** Stripe billing is configured in this installation. */
  billingConfigured: z.boolean(),
  plans: z.array(publicPlanSchema).length(4),
  apiAddon: apiAddonStateSchema,
  management: billingManagementSchema,
  /** Prepaid days (PIX or referral) in force; not refundable or cancelable here. */
  prepaid: prepaidStateSchema.nullable(),
  /** Coupon on the plan subscription (NEX-51); planIds empty means every plan. */
  appliedCoupon: z.object({ code: z.string(), planIds: z.array(paidPlanIdSchema) }).nullable().optional(),
});

export const usageStateSchema = z.object({
  current: z.object({
    limit: z.number().int().nonnegative(),
    reserved: z.number().int().nonnegative(),
    confirmed: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
    periodStart: z.iso.datetime({ offset: true }),
    periodEnd: z.iso.datetime({ offset: true }),
  }),
});

export const billingRedirectSchema = z.object({ url: z.url() });

export const billingViewSchema = billingStateSchema;
export const usageViewSchema = usageStateSchema;

export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;
export type PaidPlanId = z.infer<typeof paidPlanIdSchema>;
export type ApiAddonState = z.infer<typeof apiAddonStateSchema>;
export type BillingCheckoutRequest = z.infer<typeof billingCheckoutRequestSchema>;
export type PublicBillingPlan = z.infer<typeof publicPlanSchema>;
export type PublicPlan = PublicBillingPlan;
export type BillingView = z.infer<typeof billingStateSchema>;
export type CouponPreview = z.infer<typeof couponPreviewSchema>;
export type UsageView = z.infer<typeof usageStateSchema>;
export type BillingPlanChangeResult = z.infer<typeof billingPlanChangeResultSchema>;
export type RefundEligibility = z.infer<typeof refundEligibilitySchema>;
export type RefundResult = z.infer<typeof refundResultSchema>;
export type BillingRedirect = z.infer<typeof billingRedirectSchema>;
export type SubscribeResult = z.infer<typeof subscribeResultSchema>;
export type SavedCard = z.infer<typeof savedCardSchema>;
export type PaymentSession = z.infer<typeof paymentSessionSchema>;
export type CheckoutConfig = z.infer<typeof checkoutConfigSchema>;
