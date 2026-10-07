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
};

export type StripeSubscriptionSnapshot = {
  id: string;
  customerId: string;
  status: Stripe.Subscription.Status;
  cancelAtPeriodEnd: boolean;
  priceIds: string[];
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
};

export type CheckoutSnapshot = { id: string; url: string; expiresAt: Date };

export interface BillingProvider {
  createCustomer(input: { organizationId: string; organizationName: string }, idempotencyKey: string): Promise<{ id: string }>;
  retrievePrice(priceId: string): Promise<StripePriceSnapshot>;
  createCheckout(input: {
    customerId: string;
    priceId: string;
    organizationId: string;
    successUrl: string;
    cancelUrl: string;
    integrationIdentifier: string;
  }, idempotencyKey: string): Promise<CheckoutSnapshot>;
  createPortal(customerId: string, returnUrl: string, idempotencyKey: string): Promise<{ url: string }>;
  listSubscriptions(customerId: string): Promise<StripeSubscriptionSnapshot[]>;
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
  async createCustomer(input: { organizationId: string; organizationName: string }, idempotencyKey: string) {
    const customer = await stripe().customers.create({
      name: input.organizationName,
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
    };
  }

  async createCheckout(input: {
    customerId: string;
    priceId: string;
    organizationId: string;
    successUrl: string;
    cancelUrl: string;
    integrationIdentifier: string;
  }, idempotencyKey: string): Promise<CheckoutSnapshot> {
    const session = await stripe().checkout.sessions.create({
      mode: "subscription",
      customer: input.customerId,
      line_items: [{ price: input.priceId, quantity: 1 }],
      client_reference_id: input.organizationId,
      metadata: { organizationId: input.organizationId },
      subscription_data: { metadata: { organizationId: input.organizationId } },
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      integration_identifier: input.integrationIdentifier,
    }, { idempotencyKey });
    if (!session.url) throw new Error("stripe_checkout_url_missing");
    return { id: session.id, url: session.url, expiresAt: new Date(session.expires_at * 1_000) };
  }

  async createPortal(customerId: string, returnUrl: string, idempotencyKey: string) {
    const session = await stripe().billingPortal.sessions.create({ customer: customerId, return_url: returnUrl }, { idempotencyKey });
    return { url: session.url };
  }

  async listSubscriptions(customerId: string): Promise<StripeSubscriptionSnapshot[]> {
    const response = await stripe().subscriptions.list({ customer: customerId, status: "all", limit: 100 }).autoPagingToArray({ limit: 100 });
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
      };
    });
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
