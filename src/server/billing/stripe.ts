import { createHash } from "node:crypto";

import Stripe from "stripe";

import { requiredEnv } from "@/lib/env";

export type StripePriceSnapshot = {
  id: string;
  active: boolean;
  currency: string;
  unitAmount: number | null;
  recurringInterval: string | null;
  recurringIntervalCount: number | null;
  /** The Product the price belongs to (used to restrict coupons to plans). */
  productId?: string | null;
};

export type StripeSubscriptionSnapshot = {
  id: string;
  customerId: string;
  status: Stripe.Subscription.Status;
  cancelAtPeriodEnd: boolean;
  priceIds: string[];
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  /** Promotion Codes behind the subscription's discounts (NEX-51). Absent means none were read. */
  promotionCodeIds?: string[];
};

/** Live state of a Promotion Code and its Coupon, as Stripe enforces them. */
export type PromotionCodeSnapshot = {
  id: string;
  code: string;
  active: boolean;
  expiresAt: Date | null;
  maxRedemptions: number | null;
  timesRedeemed: number;
  firstTimeTransaction: boolean;
  coupon: {
    id: string;
    valid: boolean;
    percentOff: number | null;
    amountOff: number | null;
    currency: string | null;
    duration: "once" | "forever" | "repeating";
    durationInMonths: number | null;
  } | null;
};

export type CouponCreateInput = {
  code: string;
  /** Exactly one of percentOff (1–100) or amountOffBrlCents. */
  percentOff: number | null;
  amountOffBrlCents: number | null;
  duration: "once" | "forever" | "repeating";
  durationInMonths: number | null;
  maxRedemptions: number | null;
  expiresAt: Date | null;
  /** Our coupons.id, stored as metadata on both Stripe objects. */
  unoCouponId: string;
  /** Stripe Products the coupon applies to (the restricted plans); empty = any. */
  productIds: string[];
};

export type CheckoutSnapshot = { id: string; url: string; expiresAt: Date };

/** A paid invoice of a subscription and the PaymentIntents that paid it. */
export type PaidInvoiceSnapshot = {
  id: string;
  subscriptionId: string;
  paidAt: Date;
  amountPaid: number;
  currency: string;
  /** Each PaymentIntent that paid (part of) the invoice and how much it paid. */
  payments: Array<{ paymentIntentId: string; amount: number }>;
};

export interface BillingProvider {
  /** `phone` is the buyer's E.164 phone (NEX-51), sent to the Customer when known. */
  createCustomer(input: { organizationId: string; organizationName: string; phone?: string | null }, idempotencyKey: string): Promise<{ id: string }>;
  retrievePrice(priceId: string): Promise<StripePriceSnapshot>;
  createCheckout(input: {
    customerId: string;
    priceId: string;
    organizationId: string;
    /** Marks the resulting subscription as the API add-on instead of a plan. */
    addon?: "API";
    /** One-time coupon for the first invoice (the first-month promo); recurring invoices stay full price. */
    couponId?: string | null;
    /** A Promotion Code chosen by the server instead of the first-month coupon. Never both. */
    promotionCodeId?: string | null;
    successUrl: string;
    cancelUrl: string;
    integrationIdentifier: string;
  }, idempotencyKey: string): Promise<CheckoutSnapshot>;
  /** Expires an open Checkout Session. "complete" when it was already paid and cannot be expired. */
  expireCheckout(sessionId: string, idempotencyKey: string): Promise<"expired" | "complete">;
  /** The Promotion Code and its Coupon, or null when it does not exist. */
  retrievePromotionCode(promotionCodeId: string): Promise<PromotionCodeSnapshot | null>;
  /** Creates a Coupon and its customer-facing Promotion Code. */
  createCouponWithCode(input: CouponCreateInput, idempotencyKey: string): Promise<{ couponId: string; promotionCodeId: string }>;
  setPromotionCodeActive(promotionCodeId: string, active: boolean, idempotencyKey: string): Promise<void>;
  createPortal(customerId: string, returnUrl: string, idempotencyKey: string): Promise<{ url: string }>;
  listSubscriptions(customerId: string): Promise<StripeSubscriptionSnapshot[]>;
  /**
   * Swaps the single item priced `fromPriceId` to `toPriceId`, prorating, and clears any scheduled cancellation.
   * `removeDiscounts` drops the subscription's discounts (a coupon not valid for the new plan).
   */
  changeSubscriptionPrice(input: { subscriptionId: string; fromPriceId: string; toPriceId: string; upgrade: boolean; removeDiscounts?: boolean }, idempotencyKey: string): Promise<void>;
  /** Schedules (true) or withdraws (false) the cancellation at the end of the current period. */
  setCancelAtPeriodEnd(subscriptionId: string, cancel: boolean, idempotencyKey: string): Promise<void>;
  /** Ends the subscription right now, without proration credit. Canceling an already canceled one is a no-op. */
  cancelSubscriptionNow(subscriptionId: string, idempotencyKey: string): Promise<void>;
  /** Paid invoices of a subscription with a positive amount, oldest first. */
  listPaidInvoices(subscriptionId: string): Promise<PaidInvoiceSnapshot[]>;
  /** Amount already refunded (succeeded or still pending) for a PaymentIntent. */
  refundedAmount(paymentIntentId: string): Promise<number>;
  /** Refunds whatever is left of a PaymentIntent. */
  createRefund(input: { paymentIntentId: string; metadata: Record<string, string> }, idempotencyKey: string): Promise<{ id: string }>;
  constructEvent(rawBody: Buffer, signature: string, secret: string): Stripe.Event;
}

let stripeClient: Stripe | undefined;

function stripe(): Stripe {
  stripeClient ??= new Stripe(requiredEnv("STRIPE_SECRET_KEY"), {
    maxNetworkRetries: 2,
    timeout: 10_000,
  });
  return stripeClient;
}

function id(value: string | { id: string } | null): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

class StripeGateway implements BillingProvider {
  async createCustomer(input: { organizationId: string; organizationName: string; phone?: string | null }, idempotencyKey: string) {
    const customer = await stripe().customers.create({
      name: input.organizationName,
      ...(input.phone ? { phone: input.phone } : {}),
      metadata: { organizationId: input.organizationId },
    }, { idempotencyKey });
    return { id: customer.id };
  }

  async retrievePrice(priceId: string): Promise<StripePriceSnapshot> {
    const price = await stripe().prices.retrieve(priceId);
    return {
      id: price.id,
      active: price.active,
      currency: price.currency,
      unitAmount: price.unit_amount,
      recurringInterval: price.recurring?.interval ?? null,
      recurringIntervalCount: price.recurring?.interval_count ?? null,
      productId: typeof price.product === "string" ? price.product : price.product?.id ?? null,
    };
  }

  async createCheckout(input: {
    customerId: string;
    priceId: string;
    organizationId: string;
    addon?: "API";
    couponId?: string | null;
    promotionCodeId?: string | null;
    successUrl: string;
    cancelUrl: string;
    integrationIdentifier: string;
  }, idempotencyKey: string): Promise<CheckoutSnapshot> {
    if (input.couponId && input.promotionCodeId) throw new Error("stripe_checkout_single_discount");
    const metadata = { organizationId: input.organizationId, ...(input.addon ? { uno_addon: input.addon } : {}) };
    const session = await stripe().checkout.sessions.create({
      mode: "subscription",
      customer: input.customerId,
      line_items: [{ price: input.priceId, quantity: 1 }],
      client_reference_id: input.organizationId,
      metadata,
      subscription_data: { metadata },
      // A one-time coupon only touches the first invoice; renewals stay at the recurring price.
      // Stripe Checkout accepts a single discount: the server already chose the better one.
      ...(input.promotionCodeId ? { discounts: [{ promotion_code: input.promotionCodeId }] } : input.couponId ? { discounts: [{ coupon: input.couponId }] } : {}),
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      integration_identifier: input.integrationIdentifier,
    }, { idempotencyKey });
    if (!session.url) throw new Error("stripe_checkout_url_missing");
    return { id: session.id, url: session.url, expiresAt: new Date(session.expires_at * 1_000) };
  }

  async expireCheckout(sessionId: string, idempotencyKey: string): Promise<"expired" | "complete"> {
    const session = await stripe().checkout.sessions.retrieve(sessionId);
    if (session.status === "complete") return "complete";
    if (session.status === "expired") return "expired";
    const expired = await stripe().checkout.sessions.expire(sessionId, {}, { idempotencyKey });
    return expired.status === "complete" ? "complete" : "expired";
  }

  async retrievePromotionCode(promotionCodeId: string): Promise<PromotionCodeSnapshot | null> {
    let promotion: Stripe.PromotionCode;
    try {
      promotion = await stripe().promotionCodes.retrieve(promotionCodeId, { expand: ["promotion.coupon"] });
    } catch (error) {
      if (error instanceof Stripe.errors.StripeInvalidRequestError && error.statusCode === 404) return null;
      throw error;
    }
    const coupon = promotion.promotion.coupon && typeof promotion.promotion.coupon === "object" ? promotion.promotion.coupon : null;
    return {
      id: promotion.id,
      code: promotion.code,
      active: promotion.active,
      expiresAt: promotion.expires_at ? new Date(promotion.expires_at * 1_000) : null,
      maxRedemptions: promotion.max_redemptions,
      timesRedeemed: promotion.times_redeemed,
      firstTimeTransaction: promotion.restrictions.first_time_transaction,
      coupon: coupon ? {
        id: coupon.id,
        valid: coupon.valid,
        percentOff: coupon.percent_off,
        amountOff: coupon.amount_off,
        currency: coupon.currency,
        // Any duration Stripe may add later is treated as a one-time discount.
        duration: coupon.duration === "forever" ? "forever" : coupon.duration === "repeating" ? "repeating" : "once",
        durationInMonths: coupon.duration_in_months,
      } : null,
    };
  }

  async createCouponWithCode(input: CouponCreateInput, idempotencyKey: string): Promise<{ couponId: string; promotionCodeId: string }> {
    const metadata = { uno_coupon_id: input.unoCouponId };
    const coupon = await stripe().coupons.create({
      name: input.code,
      ...(input.percentOff !== null ? { percent_off: input.percentOff } : { amount_off: input.amountOffBrlCents!, currency: "brl" }),
      duration: input.duration,
      ...(input.duration === "repeating" ? { duration_in_months: input.durationInMonths! } : {}),
      // A plan-restricted coupon only discounts those plans' products, even after a plan swap or in the portal.
      ...(input.productIds.length ? { applies_to: { products: input.productIds } } : {}),
      metadata,
    }, { idempotencyKey: `${idempotencyKey}-coupon` });
    const promotion = await stripe().promotionCodes.create({
      promotion: { type: "coupon", coupon: coupon.id },
      code: input.code,
      ...(input.maxRedemptions !== null ? { max_redemptions: input.maxRedemptions } : {}),
      ...(input.expiresAt ? { expires_at: Math.floor(input.expiresAt.getTime() / 1_000) } : {}),
      // Stripe's customer is the organization: one use per organization, enforced by Stripe too.
      restrictions: { first_time_transaction: true },
      metadata,
    }, { idempotencyKey: `${idempotencyKey}-promotion` });
    return { couponId: coupon.id, promotionCodeId: promotion.id };
  }

  async setPromotionCodeActive(promotionCodeId: string, active: boolean, idempotencyKey: string): Promise<void> {
    await stripe().promotionCodes.update(promotionCodeId, { active }, { idempotencyKey });
  }

  async createPortal(customerId: string, returnUrl: string, idempotencyKey: string) {
    const session = await stripe().billingPortal.sessions.create({ customer: customerId, return_url: returnUrl }, { idempotencyKey });
    return { url: session.url };
  }

  async listSubscriptions(customerId: string): Promise<StripeSubscriptionSnapshot[]> {
    const response = await stripe().subscriptions.list({ customer: customerId, status: "all", limit: 100, expand: ["data.discounts"] }).autoPagingToArray({ limit: 100 });
    return response.map((subscription) => {
      const starts = subscription.items.data.map((item) => item.current_period_start).filter(Number.isFinite);
      const ends = subscription.items.data.map((item) => item.current_period_end).filter(Number.isFinite);
      return {
        id: subscription.id,
        customerId: id(subscription.customer)!,
        status: subscription.status,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        priceIds: subscription.items.data.map((item) => item.price.id),
        currentPeriodStart: starts.length ? new Date(Math.min(...starts) * 1_000) : null,
        currentPeriodEnd: ends.length ? new Date(Math.max(...ends) * 1_000) : null,
        promotionCodeIds: subscription.discounts.flatMap((discount) => {
          const promotionCode = typeof discount === "object" ? id(discount.promotion_code) : null;
          return promotionCode ? [promotionCode] : [];
        }),
      };
    });
  }

  async changeSubscriptionPrice(input: { subscriptionId: string; fromPriceId: string; toPriceId: string; upgrade: boolean; removeDiscounts?: boolean }, idempotencyKey: string): Promise<void> {
    const subscription = await stripe().subscriptions.retrieve(input.subscriptionId);
    const items = subscription.items.data.filter((item) => item.price.id === input.fromPriceId);
    if (items.length !== 1) throw new Error("stripe_subscription_item_mismatch");
    await stripe().subscriptions.update(input.subscriptionId, {
      items: [{ id: items[0]!.id, price: input.toPriceId, quantity: 1 }],
      // Upgrades invoice the prorated difference now and fail if it is not paid,
      // so a bigger quota is never used on credit; downgrades earn no credit.
      ...(input.upgrade
        ? { proration_behavior: "always_invoice" as const, payment_behavior: "error_if_incomplete" as const }
        : { proration_behavior: "none" as const }),
      cancel_at_period_end: false,
      ...(subscription.cancel_at ? { cancel_at: "" } : {}),
      ...(input.removeDiscounts ? { discounts: "" as const } : {}),
    }, { idempotencyKey });
  }

  async setCancelAtPeriodEnd(subscriptionId: string, cancel: boolean, idempotencyKey: string): Promise<void> {
    const subscription = await stripe().subscriptions.retrieve(subscriptionId);
    // Withdrawing a cancellation must also clear a fixed `cancel_at` set elsewhere (e.g. the portal).
    await stripe().subscriptions.update(subscriptionId, {
      cancel_at_period_end: cancel,
      ...(!cancel && subscription.cancel_at ? { cancel_at: "" } : {}),
    }, { idempotencyKey });
  }

  async cancelSubscriptionNow(subscriptionId: string, idempotencyKey: string): Promise<void> {
    const subscription = await stripe().subscriptions.retrieve(subscriptionId);
    if (subscription.status === "canceled" || subscription.status === "incomplete_expired") return;
    await stripe().subscriptions.cancel(subscriptionId, { invoice_now: false, prorate: false }, { idempotencyKey });
  }

  async listPaidInvoices(subscriptionId: string): Promise<PaidInvoiceSnapshot[]> {
    const invoices = await stripe().invoices.list({ subscription: subscriptionId, status: "paid", limit: 100, expand: ["data.payments"] })
      .autoPagingToArray({ limit: 100 });
    return invoices
      .filter((invoice) => invoice.amount_paid > 0 && invoice.status_transitions.paid_at !== null && invoice.id)
      .map((invoice) => ({
        id: invoice.id!,
        subscriptionId,
        paidAt: new Date(invoice.status_transitions.paid_at! * 1_000),
        amountPaid: invoice.amount_paid,
        currency: invoice.currency,
        payments: (invoice.payments?.data ?? []).flatMap((payment) => {
          const paymentIntentId = payment.payment.type === "payment_intent" ? id(payment.payment.payment_intent ?? null) : null;
          return payment.status === "paid" && paymentIntentId ? [{ paymentIntentId, amount: payment.amount_paid ?? payment.amount_requested }] : [];
        }),
      }))
      .sort((left, right) => left.paidAt.getTime() - right.paidAt.getTime());
  }

  async refundedAmount(paymentIntentId: string): Promise<number> {
    const refunds = await stripe().refunds.list({ payment_intent: paymentIntentId, limit: 100 }).autoPagingToArray({ limit: 100 });
    return refunds
      .filter((refund) => refund.status !== "failed" && refund.status !== "canceled")
      .reduce((total, refund) => total + refund.amount, 0);
  }

  async createRefund(input: { paymentIntentId: string; metadata: Record<string, string> }, idempotencyKey: string): Promise<{ id: string }> {
    const refund = await stripe().refunds.create({
      payment_intent: input.paymentIntentId,
      reason: "requested_by_customer",
      metadata: input.metadata,
    }, { idempotencyKey });
    return { id: refund.id };
  }

  constructEvent(rawBody: Buffer, signature: string, secret: string) {
    return stripe().webhooks.constructEvent(rawBody, signature, secret);
  }
}

const gateway = new StripeGateway();

export function getBillingProvider(): BillingProvider {
  return gateway;
}

export function checkoutIntegrationIdentifier(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest();
  const suffix = Array.from(bytes.subarray(0, 8), (value) => String.fromCharCode(97 + (value % 26))).join("");
  return `uno_checkout_${suffix}`;
}
