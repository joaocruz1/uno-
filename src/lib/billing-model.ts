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
export type BillingRedirect = z.infer<typeof billingRedirectSchema>;
