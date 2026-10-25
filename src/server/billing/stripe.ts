import { createHash } from "node:crypto";

import Stripe from "stripe";

import { requiredEnv } from "@/lib/env";

import { cancelUnpaidSubscription, type UnpaidInvoiceView } from "./cancel-unpaid";

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
  /** The checkout intent that created it on our own checkout (NEX-52, metadata uno_checkout_intent). */
  checkoutIntentId?: string | null;
  /** The card that pays this subscription, when it has its own default. */
  defaultPaymentMethodId?: string | null;
};

/**
 * What the browser must confirm for a subscription created by our own checkout
 * (NEX-52): the first invoice's PaymentIntent, a SetupIntent when nothing is due
 * today (100% coupon), or nothing (already paid). The client secret is handed
 * to the buyer's browser only, never stored.
 */
export type SubscriptionPaymentSnapshot = {
  id: string;
  customerId: string;
  status: Stripe.Subscription.Status;
  priceIds: string[];
  confirmation: "payment" | "setup" | "none";
  clientSecret: string | null;
  /** The first invoice's amount due, in cents. */
  amountDue: number;
  currency: string;
};

/** A card attached to the organization's Stripe Customer. Display fields only: Stripe keeps the card. */
export type SavedCardSnapshot = {
  id: string;
  customerId: string | null;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
};

export type SubscriptionCreateInput = {
  customerId: string;
  priceId: string;
  organizationId: string;
  /** Our billing_checkout_intents.id, stored as metadata uno_checkout_intent. */
  checkoutIntentId: string;
  /** Marks the subscription as the API add-on instead of a plan. */
  addon?: "API";
  /** One-time coupon for the first invoice (the first-month promo). */
  couponId?: string | null;
  /** A Promotion Code chosen by the server instead of the first-month coupon. Never both. */
  promotionCodeId?: string | null;
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
  /**
   * Own checkout (NEX-52): creates the subscription incomplete
   * (payment_behavior default_incomplete, card only, saving the card on the
   * subscription) and returns what the browser must confirm.
   */
  createSubscription(input: SubscriptionCreateInput, idempotencyKey: string): Promise<SubscriptionPaymentSnapshot>;
  /** The same snapshot for an existing subscription, or null when it does not exist. */
  retrieveSubscriptionPayment(subscriptionId: string): Promise<SubscriptionPaymentSnapshot | null>;
  /**
   * Cancels a subscription that was never paid, voiding its first invoice first
   * so a payment cannot slip in (see cancel-unpaid.ts). "paid" when it was paid
   * meanwhile and was left alone.
   */
  cancelIncompleteSubscription(subscriptionId: string, idempotencyKey: string): Promise<"canceled" | "paid">;
  /** A short-lived CustomerSession for the Payment Element (saved cards, save checkbox). */
  createCustomerSession(customerId: string): Promise<{ clientSecret: string; expiresAt: Date }>;
  /** The Customer's cards and its invoice default. */
  listCards(customerId: string): Promise<{ defaultPaymentMethodId: string | null; cards: SavedCardSnapshot[] }>;
  /** Makes a card the Customer's invoice default and the default of the given subscriptions. */
  setDefaultCard(input: { customerId: string; paymentMethodId: string; subscriptionIds: string[] }, idempotencyKey: string): Promise<void>;
  /** Removes a card from the Customer (Stripe detaches it). */
  detachCard(paymentMethodId: string, idempotencyKey: string): Promise<void>;
  /**
   * After the first payment: when the buyer chose to keep the card (allow_redisplay
   * "always"), it becomes the Customer's invoice default, so the add-on and later
   * purchases charge the same card. Never overwrites an existing default.
   */
  adoptSubscriptionCard(customerId: string, subscriptionId: string): Promise<void>;
  /**
   * Expires an open hosted Checkout Session left by the flow before NEX-52.
   * "complete" when it was already paid and cannot be expired.
   */
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

  async createSubscription(input: SubscriptionCreateInput, idempotencyKey: string): Promise<SubscriptionPaymentSnapshot> {
    if (input.couponId && input.promotionCodeId) throw new Error("stripe_subscription_single_discount");
    const metadata = { organizationId: input.organizationId, uno_checkout_intent: input.checkoutIntentId, ...(input.addon ? { uno_addon: input.addon } : {}) };
    const subscription = await stripe().subscriptions.create({
      customer: input.customerId,
      items: [{ price: input.priceId, quantity: 1 }],
      metadata,
      // Nothing is charged until the browser confirms; Stripe expires it after 23 h unpaid.
      payment_behavior: "default_incomplete",
      payment_settings: { save_default_payment_method: "on_subscription", payment_method_types: ["card"] },
      // A single discount, already chosen by the server (best of coupon and first-month promo).
      ...(input.promotionCodeId ? { discounts: [{ promotion_code: input.promotionCodeId }] } : input.couponId ? { discounts: [{ coupon: input.couponId }] } : {}),
      expand: ["latest_invoice.confirmation_secret", "pending_setup_intent"],
    }, { idempotencyKey });
    return paymentSnapshot(subscription);
  }

  async retrieveSubscriptionPayment(subscriptionId: string): Promise<SubscriptionPaymentSnapshot | null> {
    try {
      const subscription = await stripe().subscriptions.retrieve(subscriptionId, { expand: ["latest_invoice.confirmation_secret", "pending_setup_intent"] });
      return paymentSnapshot(subscription);
    } catch (error) {
      if (error instanceof Stripe.errors.StripeInvalidRequestError && error.statusCode === 404) return null;
      throw error;
    }
  }

  async cancelIncompleteSubscription(subscriptionId: string, idempotencyKey: string): Promise<"canceled" | "paid"> {
    const invoiceView = (invoice: Stripe.Invoice): UnpaidInvoiceView => ({
      id: invoice.id!,
      status: invoice.status,
      paymentIntentIds: (invoice.payments?.data ?? []).flatMap((payment) => {
        const paymentIntentId = payment.payment.type === "payment_intent" ? id(payment.payment.payment_intent ?? null) : null;
        return payment.status === "paid" && paymentIntentId ? [paymentIntentId] : [];
      }),
    });
    return cancelUnpaidSubscription({
      retrieve: async (subscription) => {
        const current = await stripe().subscriptions.retrieve(subscription);
        const invoiceId = id(current.latest_invoice);
        const invoice = invoiceId ? await stripe().invoices.retrieve(invoiceId, { expand: ["payments"] }) : null;
        return { status: current.status, organizationId: current.metadata?.organizationId ?? null, invoice: invoice ? invoiceView(invoice) : null };
      },
      retrieveInvoice: async (invoiceId) => invoiceView(await stripe().invoices.retrieve(invoiceId, { expand: ["payments"] })),
      voidInvoice: async (invoiceId, key) => {
        try {
          await stripe().invoices.voidInvoice(invoiceId, {}, { idempotencyKey: key });
          return "voided";
        } catch (error) {
          if (error instanceof Stripe.errors.StripeInvalidRequestError) return "refused";
          throw error;
        }
      },
      cancel: async (subscription, key) => {
        await stripe().subscriptions.cancel(subscription, { invoice_now: false, prorate: false }, { idempotencyKey: key });
      },
      refund: async (paymentIntentId, metadata, key) => {
        await stripe().refunds.create({ payment_intent: paymentIntentId, reason: "requested_by_customer", metadata }, { idempotencyKey: key });
      },
      log: (entry) => console.log(JSON.stringify(entry)),
    }, subscriptionId, idempotencyKey);
  }

  async createCustomerSession(customerId: string): Promise<{ clientSecret: string; expiresAt: Date }> {
    const session = await stripe().customerSessions.create({
      customer: customerId,
      components: {
        payment_element: {
          enabled: true,
          features: {
            // Returning buyers see their kept cards; new ones get the "save" checkbox.
            payment_method_redisplay: "enabled",
            payment_method_save: "enabled",
            payment_method_save_usage: "off_session",
            // Removal goes through the UNO (Assinatura), which refuses to remove
            // the only card paying an active subscription.
            payment_method_remove: "disabled",
          },
        },
      },
    });
    return { clientSecret: session.client_secret, expiresAt: new Date(session.expires_at * 1_000) };
  }

  async listCards(customerId: string): Promise<{ defaultPaymentMethodId: string | null; cards: SavedCardSnapshot[] }> {
    const [customer, methods] = await Promise.all([
      stripe().customers.retrieve(customerId),
      stripe().customers.listPaymentMethods(customerId, { type: "card", limit: 100 }).autoPagingToArray({ limit: 100 }),
    ]);
    const defaultPaymentMethodId = "deleted" in customer && customer.deleted ? null : id((customer as Stripe.Customer).invoice_settings?.default_payment_method ?? null);
    return {
      defaultPaymentMethodId,
      cards: methods.flatMap((method) => method.card ? [{
        id: method.id,
        customerId: id(method.customer ?? null),
        brand: method.card.brand,
        last4: method.card.last4,
        expMonth: method.card.exp_month,
        expYear: method.card.exp_year,
      }] : []),
    };
  }

  async setDefaultCard(input: { customerId: string; paymentMethodId: string; subscriptionIds: string[] }, idempotencyKey: string): Promise<void> {
    await stripe().customers.update(input.customerId, { invoice_settings: { default_payment_method: input.paymentMethodId } }, { idempotencyKey: `${idempotencyKey}-customer` });
    for (const subscriptionId of input.subscriptionIds) {
      await stripe().subscriptions.update(subscriptionId, { default_payment_method: input.paymentMethodId }, { idempotencyKey: `${idempotencyKey}-${subscriptionId}` });
    }
  }

  async detachCard(paymentMethodId: string, idempotencyKey: string): Promise<void> {
    await stripe().paymentMethods.detach(paymentMethodId, {}, { idempotencyKey });
  }

  async adoptSubscriptionCard(customerId: string, subscriptionId: string): Promise<void> {
    const [customer, subscription] = await Promise.all([
      stripe().customers.retrieve(customerId),
      stripe().subscriptions.retrieve(subscriptionId, { expand: ["default_payment_method"] }),
    ]);
    if ("deleted" in customer && customer.deleted) return;
    if (id(subscription.customer) !== customerId) return;
    if ((customer as Stripe.Customer).invoice_settings?.default_payment_method) return;
    const method = subscription.default_payment_method;
    if (!method || typeof method === "string" || method.allow_redisplay !== "always") return;
    await stripe().customers.update(customerId, { invoice_settings: { default_payment_method: method.id } }, { idempotencyKey: `uno-adopt-card-${subscriptionId}-${method.id}` });
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
        checkoutIntentId: subscription.metadata?.uno_checkout_intent ?? null,
        defaultPaymentMethodId: id(subscription.default_payment_method),
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

function paymentSnapshot(subscription: Stripe.Subscription): SubscriptionPaymentSnapshot {
  const invoice = subscription.latest_invoice && typeof subscription.latest_invoice === "object" ? subscription.latest_invoice : null;
  const setup = subscription.pending_setup_intent && typeof subscription.pending_setup_intent === "object" ? subscription.pending_setup_intent : null;
  const amountDue = invoice?.amount_due ?? 0;
  const paymentSecret = invoice?.confirmation_secret?.client_secret ?? null;
  let confirmation: SubscriptionPaymentSnapshot["confirmation"] = "none";
  let clientSecret: string | null = null;
  if (subscription.status === "incomplete" && amountDue > 0 && paymentSecret) {
    confirmation = "payment";
    clientSecret = paymentSecret;
  } else if (setup?.client_secret && setup.status !== "succeeded" && setup.status !== "canceled") {
    // Nothing due today (100% coupon): the card is still collected for renewals.
    confirmation = "setup";
    clientSecret = setup.client_secret;
  }
  return {
    id: subscription.id,
    customerId: id(subscription.customer)!,
    status: subscription.status,
    priceIds: subscription.items.data.map((item) => item.price.id),
    confirmation,
    clientSecret,
    amountDue,
    currency: invoice?.currency ?? subscription.currency,
  };
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
