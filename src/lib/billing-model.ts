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

/** Checkout request: exactly one of a paid plan or the API add-on. */
export const billingCheckoutRequestSchema = z.union([
  z.object({ planId: paidPlanIdSchema }).strict(),
  z.object({ addon: apiAddonIdSchema }).strict(),
]);

/** POST billing/plan: swap the plan of the live card subscription. */
export const billingPlanChangeRequestSchema = z.object({ planId: paidPlanIdSchema }).strict();

/** POST billing/cancel and billing/resume: the "+ API" add-on follows the plan by default. */
export const billingCancelRequestSchema = z.object({ alsoAddon: z.boolean().optional() }).strict();

/** Without a card subscription the plan is bought through the regular Checkout. */
export const billingPlanChangeResultSchema = z.union([
  z.object({ checkout: z.literal(true) }),
  z.object({ checkout: z.literal(false), planId: paidPlanIdSchema }),
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
  plans: z.array(publicPlanSchema).length(4),
  apiAddon: apiAddonStateSchema,
  management: billingManagementSchema,
  /** Prepaid days (PIX or referral) in force; not refundable or cancelable here. */
  prepaid: prepaidStateSchema.nullable(),
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
export type UsageView = z.infer<typeof usageStateSchema>;
export type BillingPlanChangeResult = z.infer<typeof billingPlanChangeResultSchema>;
export type RefundEligibility = z.infer<typeof refundEligibilitySchema>;
export type RefundResult = z.infer<typeof refundResultSchema>;
export type BillingRedirect = z.infer<typeof billingRedirectSchema>;
