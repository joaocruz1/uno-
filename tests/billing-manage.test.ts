import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import { billingCheckoutIntents, coupons, organizations, subscriptions, usagePeriods, user, type UnoDatabase } from "@/db";
import { billingCancelRequestSchema, billingPlanChangeRequestSchema } from "@/lib/billing-model";
import {
  cancelBillingSubscription,
  changeBillingPlan,
  createBillingCheckout,
  readBillingState,
  readRefundEligibility,
  reconcileStripeCustomer,
  requestBillingRefund,
  resumeBillingSubscription,
} from "@/server/billing";
import type { ManageDependencies } from "@/server/billing/manage";
import type { BillingProvider, PaidInvoiceSnapshot, StripeSubscriptionSnapshot } from "@/server/billing/stripe";

const USER = "00000000-0000-4000-8000-000000000001";
const ORG = "00000000-0000-4000-8000-000000000201";
const OTHER_ORG = "00000000-0000-4000-8000-000000000202";
const NOW = new Date("2026-10-07T12:00:00.000Z");
const DAY = 86_400_000;
const KEY = "manage-idempotency-0001";

const pglite = new PGlite();
const database = drizzle(pglite, { schema }) as unknown as UnoDatabase;

/** Stateful synthetic Stripe: subscriptions, paid invoices and refunds of one test. */
class ManageProvider implements BillingProvider {
  subs = new Map<string, StripeSubscriptionSnapshot>();
  invoices = new Map<string, PaidInvoiceSnapshot[]>();
  refunds: Array<{ id: string; paymentIntentId: string; amount: number; idempotencyKey: string; metadata: Record<string, string> }> = [];
  calls: string[] = [];
  upgrades: boolean[] = [];
  /** PaymentIntents whose next refund attempt fails, to simulate a partial failure. */
  failRefundFor = new Set<string>();
  prices: Record<string, number> = { price_starter: 1_900, price_pro: 4_900, price_business: 13_900, price_addon: 5_000 };

  addSubscription(snapshot: Partial<StripeSubscriptionSnapshot> & { id: string; priceIds: string[] }) {
    this.subs.set(snapshot.id, {
      customerId: "cus_manage", status: "active", cancelAtPeriodEnd: false,
      currentPeriodStart: new Date(NOW.getTime() - 2 * DAY), currentPeriodEnd: new Date(NOW.getTime() + 28 * DAY),
      ...snapshot,
    });
  }

  addInvoice(subscriptionId: string, id: string, paidAt: Date, amount: number) {
    const list = this.invoices.get(subscriptionId) ?? [];
    list.push({ id, subscriptionId, paidAt, amountPaid: amount, currency: "brl", payments: [{ paymentIntentId: `pi_${id}`, amount }] });
    this.invoices.set(subscriptionId, list);
  }

  async createCustomer() { return { id: "cus_manage" }; }
  async retrievePrice(priceId: string) {
    return { id: priceId, active: true, currency: "brl", unitAmount: this.prices[priceId] ?? null, recurringInterval: "month", recurringIntervalCount: 1 };
  }
  async createSubscription(): Promise<never> { throw new Error("unused"); }
  async retrieveSubscriptionPayment(): Promise<never> { throw new Error("unused"); }
  async cancelIncompleteSubscription(): Promise<never> { throw new Error("unused"); }
  async createCustomerSession(): Promise<never> { throw new Error("unused"); }
  async listCards() { return { defaultPaymentMethodId: null, cards: [] }; }
  async setDefaultCard(): Promise<never> { throw new Error("unused"); }
  async detachCard(): Promise<never> { throw new Error("unused"); }
  async adoptSubscriptionCard() {}
  async createPortal() { return { url: "https://billing.stripe.com/p/session/test" }; }
  async listSubscriptions(customerId: string) {
    return [...this.subs.values()].filter((snapshot) => snapshot.customerId === customerId).map((snapshot) => ({ ...snapshot, priceIds: [...snapshot.priceIds] }));
  }
  removedDiscounts: string[] = [];
  async changeSubscriptionPrice(input: { subscriptionId: string; fromPriceId: string; toPriceId: string; upgrade: boolean; removeDiscounts?: boolean }, idempotencyKey: string) {
    if (input.removeDiscounts) this.removedDiscounts.push(input.subscriptionId);
    this.calls.push(`change:${input.subscriptionId}:${input.toPriceId}:${idempotencyKey}`);
    this.upgrades.push(input.upgrade);
    const subscription = this.subs.get(input.subscriptionId)!;
    subscription.priceIds = subscription.priceIds.map((priceId) => priceId === input.fromPriceId ? input.toPriceId : priceId);
    subscription.cancelAtPeriodEnd = false;
  }
  async setCancelAtPeriodEnd(subscriptionId: string, cancel: boolean) {
    this.calls.push(`${cancel ? "cancel" : "resume"}:${subscriptionId}`);
    this.subs.get(subscriptionId)!.cancelAtPeriodEnd = cancel;
  }
  async cancelSubscriptionNow(subscriptionId: string) {
    this.calls.push(`end:${subscriptionId}`);
    this.subs.get(subscriptionId)!.status = "canceled";
  }
  async listPaidInvoices(subscriptionId: string) { return [...(this.invoices.get(subscriptionId) ?? [])]; }
  async refundedAmount(paymentIntentId: string) {
    return this.refunds.filter((refund) => refund.paymentIntentId === paymentIntentId).reduce((total, refund) => total + refund.amount, 0);
  }
  async expireCheckout(): Promise<"expired" | "complete"> { return "expired"; }
  async retrievePromotionCode() { return null; }
  async createCouponWithCode(): Promise<{ couponId: string; promotionCodeId: string }> { throw new Error("unused"); }
  async setPromotionCodeActive() { throw new Error("unused"); }
  async createRefund(input: { paymentIntentId: string; metadata: Record<string, string> }, idempotencyKey: string) {
    const replay = this.refunds.find((refund) => refund.idempotencyKey === idempotencyKey);
    if (replay) return { id: replay.id };
    if (this.failRefundFor.delete(input.paymentIntentId)) throw new Error("synthetic_provider_failure");
    const paid = [...this.invoices.values()].flat().flatMap((invoice) => invoice.payments).find((payment) => payment.paymentIntentId === input.paymentIntentId)!.amount;
    const amount = paid - await this.refundedAmount(input.paymentIntentId);
    if (amount <= 0) throw new Error("charge_already_refunded");
    const id = `re_${this.refunds.length + 1}`;
    this.refunds.push({ id, paymentIntentId: input.paymentIntentId, amount, idempotencyKey, metadata: input.metadata });
    return { id };
  }
  constructEvent(): Stripe.Event { throw new Error("unused"); }
}

async function migrate() {
  const directory = fileURLToPath(new URL("../drizzle", import.meta.url));
  const names = (await readdir(directory)).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
  for (const name of names) {
    const migration = await readFile(`${directory}/${name}`, "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) if (statement.trim()) await pglite.exec(statement);
  }
}

const owner = { organizationId: ORG, organizationName: "Manage Org", userId: USER, membershipRole: "OWNER" as const };
const member = { ...owner, membershipRole: "MEMBER" as const };
const otherOwner = { ...owner, organizationId: OTHER_ORG, organizationName: "Other Manage Org" };

let provider: ManageProvider;
let deps: ManageDependencies;

async function row(organizationId = ORG) {
  return (await database.select().from(subscriptions).where(eq(subscriptions.organizationId, organizationId)).limit(1))[0]!;
}

/** ORG on Starter by card, paid `daysAgo`, optionally with the "+ API" add-on paid the same day. */
async function subscribe({ daysAgo = 2, addon = false, planId = "price_starter", amount = 999 }: { daysAgo?: number; addon?: boolean; planId?: string; amount?: number } = {}) {
  provider.addSubscription({ id: "sub_plan", priceIds: [planId] });
  provider.addInvoice("sub_plan", "in_plan_1", new Date(NOW.getTime() - daysAgo * DAY), amount);
  if (addon) {
    provider.addSubscription({ id: "sub_addon", priceIds: ["price_addon"] });
    provider.addInvoice("sub_addon", "in_addon_1", new Date(NOW.getTime() - daysAgo * DAY + 60_000), 5_000);
  }
  await database.update(subscriptions).set({ stripeCustomerId: "cus_manage", stripeSubscriptionId: "sub_plan" }).where(eq(subscriptions.organizationId, ORG));
  await reconcileStripeCustomer("cus_manage", deps);
}

beforeAll(async () => {
  await migrate();
  await database.insert(user).values({ id: USER, name: "Manage", email: "manage@example.test", emailVerified: true });
  await database.insert(organizations).values([
    { id: ORG, name: "Manage Org", slug: "manage-org", ownerUserId: USER },
    { id: OTHER_ORG, name: "Other Manage Org", slug: "manage-other", ownerUserId: USER },
  ]);
});

beforeEach(async () => {
  vi.stubEnv("APP_URL", "http://localhost:3000");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_synthetic");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_synthetic");
  vi.stubEnv("STRIPE_PRICE_STARTER", "price_starter");
  vi.stubEnv("STRIPE_PRICE_PRO", "price_pro");
  vi.stubEnv("STRIPE_PRICE_BUSINESS", "price_business");
  vi.stubEnv("STRIPE_PRICE_API_ADDON", "price_addon");
  vi.stubEnv("UNO_API_ADDON_PRICE_BRL_CENTS", "");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  provider = new ManageProvider();
  deps = { database, provider, now: () => NOW };
  await database.delete(billingCheckoutIntents);
  await database.delete(usagePeriods);
  await database.delete(subscriptions);
  await database.insert(subscriptions).values([
    { organizationId: ORG, planId: "FREE", status: "ACTIVE" },
    { organizationId: OTHER_ORG, planId: "FREE", status: "ACTIVE" },
  ]);
});

afterAll(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await pglite.close(); });

describe("request schemas", () => {
  it("accepts only a paid plan and an optional add-on flag", () => {
    expect(billingPlanChangeRequestSchema.safeParse({ planId: "PRO" }).success).toBe(true);
    expect(billingPlanChangeRequestSchema.safeParse({ planId: "FREE" }).success).toBe(false);
    expect(billingPlanChangeRequestSchema.safeParse({ planId: "PRO", extra: 1 }).success).toBe(false);
    expect(billingCancelRequestSchema.safeParse({}).success).toBe(true);
    expect(billingCancelRequestSchema.safeParse({ alsoAddon: "yes" }).success).toBe(false);
  });
});

describe("plan change", () => {
  it("swaps the plan in place, prorating, and reconciles immediately", async () => {
    await subscribe();
    await provider.setCancelAtPeriodEnd("sub_plan", true);
    await reconcileStripeCustomer("cus_manage", deps);
    const result = await changeBillingPlan(owner, "PRO", KEY, deps);
    expect(result).toEqual({ checkout: false, planId: "PRO", couponRemoved: null });
    expect(provider.removedDiscounts).toEqual([]);
    expect(provider.subs.get("sub_plan")).toMatchObject({ priceIds: ["price_pro"], cancelAtPeriodEnd: false });
    expect(provider.calls).toContain(`change:sub_plan:price_pro:uno-plan-sub_plan-PRO-${KEY}`);
    expect(await row()).toMatchObject({ planId: "PRO", cancelAtPeriodEnd: false, stripeSubscriptionId: "sub_plan" });
    // Starter → Pro is charged now; Pro → Starter earns no credit.
    await changeBillingPlan(owner, "STARTER", "downgrade-key-0123456789", deps);
    expect(provider.upgrades).toEqual([true, false]);
  });

  it("removes a coupon restricted to other plans when swapping, and says so (NEX-51)", async () => {
    await subscribe();
    const [restricted] = await database.insert(coupons).values({
      code: "SOSTARTER", stripeCouponId: "coupon_s", stripePromotionCodeId: "promo_s", discountType: "PERCENT", percentOff: 50,
      duration: "forever", planIds: ["STARTER"],
    }).returning();
    await database.update(subscriptions).set({ appliedCouponId: restricted!.id, appliedCouponCode: "SOSTARTER", appliedPromotionCodeId: "promo_s" })
      .where(eq(subscriptions.organizationId, ORG));
    expect((await readBillingState(owner, database, NOW)).appliedCoupon).toEqual({ code: "SOSTARTER", planIds: ["STARTER"] });
    expect(await changeBillingPlan(owner, "PRO", KEY, deps)).toEqual({ checkout: false, planId: "PRO", couponRemoved: "SOSTARTER" });
    expect(provider.removedDiscounts).toEqual(["sub_plan"]);
    expect(await row()).toMatchObject({ planId: "PRO", appliedCouponId: null, appliedCouponCode: null });
    // A coupon valid for every plan stays.
    await database.update(coupons).set({ planIds: [] });
    await database.update(subscriptions).set({ appliedCouponId: restricted!.id }).where(eq(subscriptions.organizationId, ORG));
    expect(await changeBillingPlan(owner, "STARTER", "downgrade-key-0123456789", deps)).toMatchObject({ couponRemoved: null });
    expect(provider.removedDiscounts).toEqual(["sub_plan"]);
    await database.update(subscriptions).set({ appliedCouponId: null }).where(eq(subscriptions.organizationId, ORG));
    await database.delete(coupons);
  });

  it("rejects the current plan and an invalid target price", async () => {
    await subscribe();
    await expect(changeBillingPlan(owner, "STARTER", KEY, deps)).rejects.toMatchObject({ code: "same_plan", status: 409 });
    provider.prices.price_business = 1;
    await expect(changeBillingPlan(owner, "BUSINESS", KEY, deps)).rejects.toMatchObject({ code: "service_unavailable" });
    expect(provider.calls.filter((call) => call.startsWith("change:"))).toEqual([]);
  });

  it("sends an organization without a card subscription to the Checkout", async () => {
    expect(await changeBillingPlan(owner, "PRO", KEY, deps)).toEqual({ checkout: true });
    await expect(changeBillingPlan(owner, "PRO", null, deps)).rejects.toMatchObject({ code: "invalid_idempotency_key" });
  });
});

describe("cancellation", () => {
  it("cancels at period end with the add-on by default and keeps the rights until then", async () => {
    await subscribe({ addon: true });
    const result = await cancelBillingSubscription(owner, {}, KEY, deps);
    expect(result.cancelAtPeriodEnd).toBe(true);
    expect(provider.subs.get("sub_plan")?.cancelAtPeriodEnd).toBe(true);
    expect(provider.subs.get("sub_addon")?.cancelAtPeriodEnd).toBe(true);
    const state = await readBillingState(owner, database, NOW);
    expect(state).toMatchObject({ effectivePlanId: "STARTER", cancelAtPeriodEnd: true, management: { changePlan: true, cancel: false, resume: true } });
    expect(state.apiAddon.active).toBe(true);

    await resumeBillingSubscription(owner, {}, "manage-idempotency-0002", deps);
    expect(provider.subs.get("sub_plan")?.cancelAtPeriodEnd).toBe(false);
    expect(provider.subs.get("sub_addon")?.cancelAtPeriodEnd).toBe(false);
    expect((await readBillingState(owner, database, NOW)).management).toEqual({ changePlan: true, cancel: true, resume: false });
  });

  it("can keep the add-on running", async () => {
    await subscribe({ addon: true });
    await cancelBillingSubscription(owner, { alsoAddon: false }, KEY, deps);
    expect(provider.subs.get("sub_plan")?.cancelAtPeriodEnd).toBe(true);
    expect(provider.subs.get("sub_addon")?.cancelAtPeriodEnd).toBe(false);
  });

  it("refuses without a card subscription", async () => {
    await expect(cancelBillingSubscription(owner, {}, KEY, deps)).rejects.toMatchObject({ code: "no_card_subscription", status: 409 });
  });
});

describe("7-day refund", () => {
  it("refunds plan and add-on, ends both now and returns the organization to Free", async () => {
    await subscribe({ daysAgo: 2, addon: true });
    const eligibility = await readRefundEligibility(owner, deps);
    expect(eligibility).toEqual({
      eligible: true, reason: null, inProgress: false, amountBrlCents: 5_999,
      deadline: new Date(NOW.getTime() + 5 * DAY).toISOString(),
    });
    const result = await requestBillingRefund(owner, KEY, deps);
    expect(result).toEqual({ refundedBrlCents: 5_999, refundedAt: NOW.toISOString() });
    expect(provider.refunds.map((refund) => [refund.paymentIntentId, refund.amount, refund.idempotencyKey])).toEqual([
      ["pi_in_plan_1", 999, "uno-refund-in_plan_1-pi_in_plan_1"],
      ["pi_in_addon_1", 5_000, "uno-refund-in_addon_1-pi_in_addon_1"],
    ]);
    expect(provider.refunds[0]?.metadata).toEqual({ organizationId: ORG, uno_refund: "7d", invoiceId: "in_plan_1" });
    expect(provider.subs.get("sub_plan")?.status).toBe("canceled");
    expect(provider.subs.get("sub_addon")?.status).toBe("canceled");
    const local = await row();
    expect(local).toMatchObject({ status: "CANCELED", apiAddonStatus: "CANCELED" });
    expect(local.refundedAt?.toISOString()).toBe(NOW.toISOString());
    const state = await readBillingState(owner, database, NOW);
    expect(state.effectivePlanId).toBe("FREE");
    expect(state.apiAddon.active).toBe(false);
  });

  it("accepts the last instant of the window and refuses after 7 days", async () => {
    await subscribe({ daysAgo: 7 });
    expect((await readRefundEligibility(owner, deps)).eligible).toBe(true);
    provider = new ManageProvider();
    deps = { database, provider, now: () => NOW };
    await subscribe({ daysAgo: 7.01 });
    const eligibility = await readRefundEligibility(owner, deps);
    expect(eligibility).toMatchObject({ eligible: false, reason: "window_expired", amountBrlCents: 0 });
    await expect(requestBillingRefund(owner, KEY, deps)).rejects.toMatchObject({ code: "refund_not_eligible", status: 409 });
    expect(provider.refunds).toEqual([]);
    expect(provider.subs.get("sub_plan")?.status).toBe("active");
  });

  it("allows one refund per organization", async () => {
    await subscribe();
    await requestBillingRefund(owner, KEY, deps);
    // Subscribing again opens no new 7-day refund for the same organization.
    provider.addSubscription({ id: "sub_plan_2", priceIds: ["price_pro"] });
    provider.addInvoice("sub_plan_2", "in_plan_2", NOW, 1_599);
    await database.update(subscriptions).set({ stripeSubscriptionId: "sub_plan_2" }).where(eq(subscriptions.organizationId, ORG));
    await reconcileStripeCustomer("cus_manage", deps);
    expect(await readRefundEligibility(owner, deps)).toMatchObject({ eligible: false, reason: "already_refunded" });
    await expect(requestBillingRefund(owner, "manage-idempotency-0002", deps)).rejects.toMatchObject({ code: "refund_already_used", status: 409 });
    expect(provider.refunds).toHaveLength(1);
    expect(provider.subs.get("sub_plan_2")?.status).toBe("active");
  });

  it("finishes after a partial failure without refunding twice", async () => {
    await subscribe({ addon: true });
    provider.failRefundFor.add("pi_in_addon_1");
    await expect(requestBillingRefund(owner, KEY, deps)).rejects.toMatchObject({ code: "service_unavailable" });
    expect(provider.refunds.map((refund) => refund.paymentIntentId)).toEqual(["pi_in_plan_1"]);
    const interrupted = await row();
    expect(interrupted.refundStartedAt).not.toBeNull();
    expect(interrupted.refundedAt).toBeNull();
    // While interrupted, nothing else can change or be bought.
    await expect(changeBillingPlan(owner, "PRO", KEY, deps)).rejects.toMatchObject({ code: "refund_in_progress" });
    await expect(cancelBillingSubscription(owner, {}, KEY, deps)).rejects.toMatchObject({ code: "refund_in_progress" });
    const checkoutDeps = { database, provider, now: () => NOW, randomId: () => "00000000-0000-4000-8000-000000009999" };
    await expect(createBillingCheckout(owner, "PRO", KEY, checkoutDeps)).rejects.toMatchObject({ code: "refund_in_progress" });
    expect(await readRefundEligibility(owner, { ...deps, now: () => new Date(NOW.getTime() + 30 * DAY) })).toMatchObject({ eligible: true, inProgress: true, amountBrlCents: 5_000 });

    const result = await requestBillingRefund(owner, "manage-idempotency-0002", deps);
    expect(result.refundedBrlCents).toBe(5_999);
    expect(provider.refunds.map((refund) => [refund.paymentIntentId, refund.amount])).toEqual([["pi_in_plan_1", 999], ["pi_in_addon_1", 5_000]]);
    expect((await row()).refundedAt).not.toBeNull();
    await expect(requestBillingRefund(owner, "manage-idempotency-0003", deps)).rejects.toMatchObject({ code: "refund_already_used" });
    expect(provider.refunds).toHaveLength(2);
  });

  it("is not offered without a paid card invoice", async () => {
    expect(await readRefundEligibility(owner, deps)).toMatchObject({ eligible: false, reason: "no_card_subscription" });
    provider.addSubscription({ id: "sub_plan", priceIds: ["price_starter"], status: "trialing" });
    await database.update(subscriptions).set({ stripeCustomerId: "cus_manage", stripeSubscriptionId: "sub_plan" }).where(eq(subscriptions.organizationId, ORG));
    await reconcileStripeCustomer("cus_manage", deps);
    expect(await readRefundEligibility(owner, deps)).toMatchObject({ eligible: false, reason: "no_paid_invoice" });
  });
});

describe("authorization and isolation", () => {
  it("forbids members from every management action", async () => {
    await subscribe({ addon: true });
    await expect(changeBillingPlan(member, "PRO", KEY, deps)).rejects.toMatchObject({ code: "forbidden", status: 403 });
    await expect(cancelBillingSubscription(member, {}, KEY, deps)).rejects.toMatchObject({ code: "forbidden" });
    await expect(resumeBillingSubscription(member, {}, KEY, deps)).rejects.toMatchObject({ code: "forbidden" });
    await expect(readRefundEligibility(member, deps)).rejects.toMatchObject({ code: "forbidden" });
    await expect(requestBillingRefund(member, KEY, deps)).rejects.toMatchObject({ code: "forbidden" });
    expect((await readBillingState(member, database, NOW)).management).toEqual({ changePlan: false, cancel: false, resume: false });
    expect(provider.calls).toEqual([]);
    expect(provider.refunds).toEqual([]);
  });

  it("never touches another organization's subscription", async () => {
    await subscribe({ addon: true });
    expect(await changeBillingPlan(otherOwner, "PRO", KEY, deps)).toEqual({ checkout: true });
    await expect(cancelBillingSubscription(otherOwner, {}, KEY, deps)).rejects.toMatchObject({ code: "no_card_subscription" });
    expect(await readRefundEligibility(otherOwner, deps)).toMatchObject({ eligible: false, reason: "no_card_subscription" });
    await expect(requestBillingRefund(otherOwner, KEY, deps)).rejects.toMatchObject({ code: "refund_not_eligible" });
    expect(provider.calls).toEqual([]);
    expect(provider.refunds).toEqual([]);
    expect(await row()).toMatchObject({ planId: "STARTER", cancelAtPeriodEnd: false, refundStartedAt: null });
    expect(await row(OTHER_ORG)).toMatchObject({ planId: "FREE", refundStartedAt: null });
  });
});
