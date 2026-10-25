import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import {
  billingCheckoutIntents,
  organizations,
  processedStripeEvents,
  subscriptions,
  usagePeriods,
  user,
  type UnoDatabase,
} from "@/db";
import { billingCheckoutRequestSchema } from "@/lib/billing-model";
import { formatBrlCents, getApiAddon, getPlanCatalog, PlanConfigurationError } from "@/lib/plans";
import { createApiAddonCheckout, createBillingCheckout, createPaymentSession, listSavedCards, removeSavedCard, processStripeWebhook, readBillingState, readUsageState, reconcileStaleSubscriptions, reconcileStripeCustomer } from "@/server/billing";
import type { CheckoutDependencies } from "@/server/billing/checkout";
import { apiAddonConfigured, billingProviderConfigured } from "@/server/billing/config";
import { effectivePlanFromSubscription, effectivePlanId, hasApiEntitlement, type SubscriptionEntitlement } from "@/server/billing/entitlements";
import { getBillingProvider, type BillingProvider, type SavedCardSnapshot, type StripeSubscriptionSnapshot, type SubscriptionPaymentSnapshot } from "@/server/billing/stripe";

const USER = "00000000-0000-4000-8000-000000000001";
const ORG = "00000000-0000-4000-8000-000000000101";
const OTHER_ORG = "00000000-0000-4000-8000-000000000102";
const NOW = new Date("2026-10-07T12:00:00.000Z");

const pglite = new PGlite();
const database = drizzle(pglite, { schema }) as unknown as UnoDatabase;

class FakeProvider implements BillingProvider {
  subscriptionCalls: Array<{ idempotencyKey: string; input: Parameters<BillingProvider["createSubscription"]>[0] }> = [];
  /** Subscriptions created by our checkout, as Stripe would return them. */
  created = new Map<string, SubscriptionPaymentSnapshot>();
  cancelCalls: string[] = [];
  adoptCalls: string[] = [];
  sessionCalls: string[] = [];
  /** What the next created subscription looks like: due today (default), nothing due, or a setup. */
  nextPayment: Pick<SubscriptionPaymentSnapshot, "status" | "confirmation" | "amountDue"> = { status: "incomplete", confirmation: "payment", amountDue: 4_900 };
  paidMeanwhile = new Set<string>();
  portalCalls = 0;
  subscriptions: StripeSubscriptionSnapshot[] = [];
  subscriptionsByCustomer = new Map<string, StripeSubscriptionSnapshot[]>();
  cards: SavedCardSnapshot[] = [];
  defaultCard: string | null = null;
  event: Stripe.Event = { id: "evt_default", type: "ping", created: Math.floor(NOW.getTime() / 1000), data: { object: {} } } as unknown as Stripe.Event;

  async createCustomer(input: { organizationId: string }) { return { id: input.organizationId === OTHER_ORG ? "cus_other" : "cus_org" }; }
  prices: Record<string, number> = { price_starter: 1_900, price_pro: 4_900, price_business: 13_900, price_addon: 5_000 };
  priceActive = true;
  async retrievePrice(priceId: string) {
    return { id: priceId, active: this.priceActive, currency: "brl", unitAmount: this.prices[priceId] ?? null, recurringInterval: "month", recurringIntervalCount: 1 };
  }
  async createSubscription(input: Parameters<BillingProvider["createSubscription"]>[0], idempotencyKey: string) {
    // Stripe answers a repeated idempotency key with the same object.
    const repeated = this.subscriptionCalls.find((call) => call.idempotencyKey === idempotencyKey);
    if (repeated) return [...this.created.values()][this.subscriptionCalls.indexOf(repeated)]!;
    this.subscriptionCalls.push({ input, idempotencyKey });
    const id = `sub_${this.subscriptionCalls.length}`;
    const snapshot: SubscriptionPaymentSnapshot = {
      id, customerId: input.customerId, priceIds: [input.priceId], currency: "brl",
      ...this.nextPayment,
      clientSecret: this.nextPayment.confirmation === "none" ? null : `${this.nextPayment.confirmation === "setup" ? "seti" : "pi"}_${this.subscriptionCalls.length}_secret_synthetic`,
    };
    this.created.set(id, snapshot);
    return snapshot;
  }
  async retrieveSubscriptionPayment(subscriptionId: string) { return this.created.get(subscriptionId) ?? null; }
  async cancelIncompleteSubscription(subscriptionId: string): Promise<"canceled" | "paid"> {
    if (this.paidMeanwhile.has(subscriptionId)) return "paid";
    this.cancelCalls.push(subscriptionId);
    const current = this.created.get(subscriptionId);
    if (current) this.created.set(subscriptionId, { ...current, status: "canceled", confirmation: "none", clientSecret: null });
    return "canceled";
  }
  async createCustomerSession(customerId: string) { this.sessionCalls.push(customerId); return { clientSecret: `cuss_${customerId}_secret_synthetic`, expiresAt: new Date(NOW.getTime() + 30 * 60_000) }; }
  async listCards() { return { defaultPaymentMethodId: this.defaultCard, cards: this.cards }; }
  defaultCalls: Array<Parameters<BillingProvider["setDefaultCard"]>[0]> = [];
  detached: string[] = [];
  async setDefaultCard(input: Parameters<BillingProvider["setDefaultCard"]>[0]) { this.defaultCalls.push(input); this.defaultCard = input.paymentMethodId; }
  async detachCard(paymentMethodId: string) { this.detached.push(paymentMethodId); this.cards = this.cards.filter((card) => card.id !== paymentMethodId); }
  async adoptSubscriptionCard(_customerId: string, subscriptionId: string) { this.adoptCalls.push(subscriptionId); }
  async createPortal() { this.portalCalls += 1; return { url: "https://billing.stripe.com/p/session/test" }; }
  async listSubscriptions(customerId: string) { return this.subscriptionsByCustomer.get(customerId) ?? this.subscriptions; }
  // Plan management is covered by tests/billing-manage.test.ts with a stateful fake.
  async changeSubscriptionPrice() { throw new Error("unused"); }
  async setCancelAtPeriodEnd() { throw new Error("unused"); }
  async cancelSubscriptionNow() { throw new Error("unused"); }
  async listPaidInvoices() { return []; }
  async refundedAmount() { return 0; }
  async expireCheckout(): Promise<"expired" | "complete"> { return "expired"; }
  async retrievePromotionCode() { return null; }
  async createCouponWithCode(): Promise<{ couponId: string; promotionCodeId: string }> { throw new Error("unused"); }
  async setPromotionCodeActive() { throw new Error("unused"); }
  async createRefund(): Promise<{ id: string }> { throw new Error("unused"); }
  constructEvent() { return this.event; }
}

async function migrate() {
  const directory = fileURLToPath(new URL("../drizzle", import.meta.url));
  const names = (await readdir(directory)).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
  for (const name of names) {
    const migration = await readFile(`${directory}/${name}`, "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) if (statement.trim()) await pglite.exec(statement);
  }
}

beforeAll(async () => {
  await migrate();
  await database.insert(user).values({ id: USER, name: "Billing", email: "billing@example.test", emailVerified: true });
  await database.insert(organizations).values([
    { id: ORG, name: "Billing Org", slug: "billing-org", ownerUserId: USER },
    { id: OTHER_ORG, name: "Other Billing Org", slug: "billing-other", ownerUserId: USER },
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
  await database.delete(processedStripeEvents);
  await database.delete(billingCheckoutIntents);
  await database.delete(usagePeriods);
  await database.delete(subscriptions);
  await database.insert(subscriptions).values([
    { organizationId: ORG, planId: "FREE", status: "ACTIVE" },
    { organizationId: OTHER_ORG, planId: "FREE", status: "ACTIVE" },
  ]);
});

afterAll(async () => { vi.unstubAllEnvs(); await pglite.close(); });

describe("billing entitlements and configuration", () => {
  it("only grants paid rights for active or trialing current periods", () => {
    const period = { planId: "PRO" as const, currentPeriodStart: new Date(NOW.getTime() - 1), currentPeriodEnd: new Date(NOW.getTime() + 1) };
    expect(effectivePlanId({ ...period, status: "ACTIVE" }, NOW)).toBe("PRO");
    expect(effectivePlanId({ ...period, status: "TRIALING" }, NOW)).toBe("PRO");
    expect(effectivePlanId({ ...period, status: "PAST_DUE" }, NOW)).toBe("FREE");
    expect(effectivePlanId({ ...period, status: "ACTIVE", currentPeriodEnd: NOW }, NOW)).toBe("FREE");
  });

  it("charges the new monthly prices and includes the API in no plan", () => {
    const catalog = getPlanCatalog({ NODE_ENV: "test" });
    expect([catalog.FREE, catalog.STARTER, catalog.PRO, catalog.BUSINESS].map((plan) => plan.priceBrlCents)).toEqual([0, 1_900, 4_900, 13_900]);
    expect([catalog.FREE, catalog.STARTER, catalog.PRO, catalog.BUSINESS].map((plan) => plan.firstMonthPriceBrlCents)).toEqual([0, 999, 1_599, 2_990]);
    expect(Object.values(catalog).every((plan) => plan.api === false)).toBe(true);
    expect(getApiAddon({ NODE_ENV: "test" })).toMatchObject({ id: "API", name: "API", priceBrlCents: 5_000 });
    expect(getApiAddon({ NODE_ENV: "test", UNO_API_ADDON_PRICE_BRL_CENTS: "6500" }).priceBrlCents).toBe(6_500);
    for (const invalid of ["0", "-1", "50.00", "abc"]) {
      expect(() => getApiAddon({ NODE_ENV: "test", UNO_API_ADDON_PRICE_BRL_CENTS: invalid })).toThrow(PlanConfigurationError);
    }
    expect([999, 1_599, 2_990, 5_000].map((cents) => formatBrlCents(cents).replace(/\s/g, " "))).toEqual(["R$ 9,99", "R$ 15,99", "R$ 29,90", "R$ 50,00"]);
  });

  it("grants the API only with an active add-on on a paid plan in force", () => {
    const later = new Date(NOW.getTime() + 86_400_000);
    const paid: SubscriptionEntitlement = {
      planId: "STARTER", status: "ACTIVE", currentPeriodStart: new Date(NOW.getTime() - 1), currentPeriodEnd: later,
      apiAddonStatus: null, apiAddonCurrentPeriodEnd: null,
    };
    const addon = { apiAddonStatus: "ACTIVE" as const, apiAddonCurrentPeriodEnd: later };
    const api = (subscription: SubscriptionEntitlement | undefined) => {
      const entitlement = effectivePlanFromSubscription(subscription, NOW);
      expect(entitlement.plan.api).toBe(hasApiEntitlement(subscription, NOW));
      return entitlement.plan.api;
    };
    expect(api(undefined)).toBe(false);
    // Paid plan without the add-on, on every paid plan.
    for (const planId of ["STARTER", "PRO", "BUSINESS"] as const) expect(api({ ...paid, planId })).toBe(false);
    // Add-on active on every paid plan; the plan's own limits are untouched.
    for (const planId of ["STARTER", "PRO", "BUSINESS"] as const) {
      expect(api({ ...paid, planId, ...addon })).toBe(true);
      expect(effectivePlanFromSubscription({ ...paid, planId, ...addon }, NOW).plan.rateLimit).toBe(getPlanCatalog()[planId].rateLimit);
    }
    expect(api({ ...paid, ...addon, apiAddonStatus: "TRIALING" })).toBe(true);
    // Add-on active but the plan is Free, not paid up, or out of its period.
    expect(api({ ...paid, planId: "FREE", ...addon })).toBe(false);
    expect(api({ ...paid, status: "PAST_DUE", ...addon })).toBe(false);
    expect(api({ ...paid, status: "CANCELED", ...addon })).toBe(false);
    expect(api({ ...paid, currentPeriodEnd: NOW, ...addon })).toBe(false);
    // Add-on expired or not in a paying state.
    expect(api({ ...paid, ...addon, apiAddonCurrentPeriodEnd: NOW })).toBe(false);
    expect(api({ ...paid, ...addon, apiAddonCurrentPeriodEnd: null })).toBe(false);
    for (const status of ["PAST_DUE", "CANCELED", "UNPAID", "PAUSED", "INCOMPLETE"] as const) {
      expect(api({ ...paid, ...addon, apiAddonStatus: status })).toBe(false);
    }
    // Prepaid add-on grant (admin): survives even when reconciliation wipes the
    // Stripe add-on status to null — the exact case that broke before.
    expect(api({ ...paid, apiAddonStatus: null, apiAddonPrepaidUntil: later })).toBe(true);
    expect(api({ ...paid, planId: "FREE", apiAddonPrepaidUntil: later })).toBe(false); // still needs a paid plan
    expect(api({ ...paid, apiAddonPrepaidUntil: NOW })).toBe(false); // prepaid window ended
  });

  it("keeps plan billing configured without the add-on price", () => {
    expect(billingProviderConfigured()).toBe(true);
    expect(apiAddonConfigured()).toBe(true);
    vi.stubEnv("STRIPE_PRICE_API_ADDON", "");
    expect(billingProviderConfigured()).toBe(true);
    expect(apiAddonConfigured()).toBe(false);
  });

  it("rejects invalid runtime plan overrides and keeps the engine file cap", () => {
    expect(() => getPlanCatalog({ NODE_ENV: "test", UNO_PLAN_PRO_MAX_FILE_MB: "101" })).toThrow(PlanConfigurationError);
    expect(getPlanCatalog({ NODE_ENV: "test", UNO_PLAN_PRO_MONTHLY_LIMIT: "2500" }).PRO.monthlyLimit).toBe(2500);
  });
});

describe("own checkout: incomplete subscription confirmed in the browser (NEX-52)", () => {
  function dependencies(provider: FakeProvider, reconciled: string[] = []): CheckoutDependencies {
    let id = 0;
    return {
      database, provider, now: () => NOW,
      randomId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
      reconcile: async (customerId) => { reconciled.push(customerId); },
    };
  }

  const actor = { organizationId: ORG, organizationName: "Billing Org", userId: USER, membershipRole: "OWNER" as const };

  it("creates one incomplete subscription per intent and returns the same client secret on retries and other keys", async () => {
    const provider = new FakeProvider();
    const deps = dependencies(provider);
    const first = await createBillingCheckout(actor, "PRO", "checkout-idempotency-0001", deps);
    const sameKey = await createBillingCheckout(actor, "PRO", "checkout-idempotency-0001", deps);
    const otherKey = await createBillingCheckout(actor, "PRO", "checkout-idempotency-0002", deps);
    expect(first).toMatchObject({ confirmation: "payment", clientSecret: "pi_1_secret_synthetic", amountDueBrlCents: 4_900, recurringBrlCents: 4_900 });
    expect(sameKey).toEqual(first);
    expect(otherKey).toEqual(first);
    expect(provider.subscriptionCalls).toHaveLength(1);
    expect(provider.subscriptionCalls[0]).toMatchObject({
      idempotencyKey: expect.stringMatching(/^uno-subscribe-.+-1$/),
      input: { customerId: "cus_org", priceId: "price_pro", organizationId: ORG, checkoutIntentId: first.intentId, couponId: null, promotionCodeId: null },
    });
    const intents = await database.select().from(billingCheckoutIntents);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ id: first.intentId, status: "OPEN", stripeSubscriptionId: "sub_1", stripeSessionId: null, checkoutUrl: null });
    // Stripe expires an unpaid subscription after 23 h; the intent follows it.
    expect(intents[0]?.expiresAt?.getTime()).toBe(NOW.getTime() + 23 * 3_600_000);
  });

  it("never stores the client secret or any card data", async () => {
    const provider = new FakeProvider();
    await createBillingCheckout(actor, "PRO", "checkout-idempotency-nostore", dependencies(provider));
    const rows = JSON.stringify([await database.select().from(billingCheckoutIntents), await database.select().from(subscriptions)]);
    expect(rows).not.toContain("secret");
    expect(rows).not.toMatch(/pm_|card|4242/i);
  });

  it("replaces a subscription that expired unpaid with a new provider attempt", async () => {
    const provider = new FakeProvider();
    const deps = dependencies(provider);
    await createBillingCheckout(actor, "PRO", "checkout-idempotency-0003", deps);
    provider.created.set("sub_1", { ...provider.created.get("sub_1")!, status: "incomplete_expired", confirmation: "none", clientSecret: null });
    const again = await createBillingCheckout(actor, "PRO", "checkout-idempotency-0003", deps);
    expect(again.clientSecret).toBe("pi_2_secret_synthetic");
    expect(provider.subscriptionCalls.map((call) => call.idempotencyKey)).toEqual([expect.stringMatching(/-1$/), expect.stringMatching(/-2$/)]);
    // The same happens when the local 23 h window ends first.
    await database.update(billingCheckoutIntents).set({ expiresAt: new Date(NOW.getTime() - 1) });
    await createBillingCheckout(actor, "PRO", "checkout-idempotency-0003", deps);
    expect(provider.subscriptionCalls.at(-1)?.idempotencyKey).toMatch(/-3$/);
  });

  it("cancels the stale incomplete subscription when the target changes, and never a paid one", async () => {
    const provider = new FakeProvider();
    const deps = dependencies(provider);
    const pro = await createBillingCheckout(actor, "PRO", "checkout-idempotency-target-1", deps);
    const business = await createBillingCheckout(actor, "BUSINESS", "checkout-idempotency-target-2", deps);
    expect(provider.cancelCalls).toEqual(["sub_1"]);
    expect(business.clientSecret).toBe("pi_2_secret_synthetic");
    const intents = await database.select().from(billingCheckoutIntents);
    expect(intents.find((intent) => intent.id === pro.intentId)?.status).toBe("EXPIRED");
    expect(intents.find((intent) => intent.id === business.intentId)).toMatchObject({ planId: "BUSINESS", status: "OPEN", stripeSubscriptionId: "sub_2" });
    // A retry from the old tab cannot cancel the newer subscription back.
    await expect(createBillingCheckout(actor, "PRO", "checkout-idempotency-target-1", deps)).rejects.toMatchObject({ code: "checkout_in_progress" });
    expect(provider.cancelCalls).toEqual(["sub_1"]);
    // Paid in the meantime (another tab confirmed it): the webhook completes it; no second contract.
    provider.paidMeanwhile.add("sub_2");
    await expect(createBillingCheckout(actor, "STARTER", "checkout-idempotency-target-3", deps)).rejects.toMatchObject({ code: "checkout_in_progress" });
    expect(provider.subscriptionCalls).toHaveLength(2);
  });

  it("cancels unpaid leftovers of lost intents before creating a new subscription", async () => {
    await database.update(subscriptions).set({ stripeCustomerId: "cus_org" }).where(eq(subscriptions.organizationId, ORG));
    const provider = new FakeProvider();
    provider.subscriptions = [{ id: "sub_lost", customerId: "cus_org", status: "incomplete", cancelAtPeriodEnd: false, priceIds: ["price_pro"], currentPeriodStart: null, currentPeriodEnd: null, checkoutIntentId: "intent-from-a-lost-request" }];
    await createBillingCheckout(actor, "PRO", "checkout-idempotency-lost", dependencies(provider));
    expect(provider.cancelCalls).toEqual(["sub_lost"]);
    expect(provider.subscriptionCalls).toHaveLength(1);
  });

  it("skips the confirmation when nothing is due and applies the plan without waiting for the webhook", async () => {
    const provider = new FakeProvider();
    provider.nextPayment = { status: "active", confirmation: "none", amountDue: 0 };
    const reconciled: string[] = [];
    const deps = dependencies(provider, reconciled);
    const result = await createBillingCheckout(actor, "PRO", "checkout-idempotency-free", deps);
    expect(result).toMatchObject({ confirmation: "none", clientSecret: null, amountDueBrlCents: 0 });
    expect(reconciled).toEqual(["cus_org"]);
    // A 100% first invoice still collects the card for the renewals.
    provider.nextPayment = { status: "active", confirmation: "setup", amountDue: 0 };
    await database.delete(billingCheckoutIntents);
    const setup = await createBillingCheckout(actor, "STARTER", "checkout-idempotency-setup", deps);
    expect(setup).toMatchObject({ confirmation: "setup", clientSecret: "seti_2_secret_synthetic", amountDueBrlCents: 0 });
  });

  it("blocks members before calling the provider", async () => {
    const provider = new FakeProvider();
    await expect(createBillingCheckout({ ...actor, membershipRole: "MEMBER" }, "PRO", "checkout-idempotency-0004", dependencies(provider)))
      .rejects.toMatchObject({ code: "forbidden", status: 403 });
    expect(provider.subscriptionCalls).toHaveLength(0);
  });

  it("keeps each organization's intent, customer and subscription apart", async () => {
    const provider = new FakeProvider();
    const deps = dependencies(provider);
    const own = await createBillingCheckout(actor, "PRO", "checkout-idempotency-shared", deps);
    const other = await createBillingCheckout({ ...actor, organizationId: OTHER_ORG, organizationName: "Other" }, "PRO", "checkout-idempotency-shared", deps);
    expect(other.intentId).not.toBe(own.intentId);
    expect(other.clientSecret).not.toBe(own.clientSecret);
    expect(provider.subscriptionCalls.map((call) => [call.input.customerId, call.input.organizationId])).toEqual([["cus_org", ORG], ["cus_other", OTHER_ORG]]);
    const rows = await database.select().from(billingCheckoutIntents);
    expect(rows.map((row) => row.organizationId).sort()).toEqual([ORG, OTHER_ORG].sort());
  });

  it("refuses a second paid contract that only Stripe knows about", async () => {
    await database.update(subscriptions).set({ stripeCustomerId: "cus_org", status: "CANCELED" })
      .where(eq(subscriptions.organizationId, ORG));
    const provider = new FakeProvider();
    provider.subscriptions = [{
      id: "sub_remote", customerId: "cus_org", status: "active", cancelAtPeriodEnd: false,
      priceIds: ["price_unknown_legacy"], currentPeriodStart: new Date("2026-10-01"), currentPeriodEnd: new Date("2026-11-01"),
    }];
    await expect(createBillingCheckout(actor, "PRO", "checkout-idempotency-0005", dependencies(provider))).rejects.toMatchObject({ code: "subscription_exists", status: 409 });
    expect(provider.subscriptionCalls).toHaveLength(0);
    expect((await database.select().from(billingCheckoutIntents))[0]?.status).toBe("FAILED");
  });

  it("refuses when the organization already has a live card subscription", async () => {
    await database.update(subscriptions).set({ stripeCustomerId: "cus_org", stripeSubscriptionId: "sub_live", status: "ACTIVE", planId: "PRO" }).where(eq(subscriptions.organizationId, ORG));
    const provider = new FakeProvider();
    await expect(createBillingCheckout(actor, "BUSINESS", "checkout-idempotency-live", dependencies(provider))).rejects.toMatchObject({ code: "subscription_exists" });
    expect(provider.subscriptionCalls).toHaveLength(0);
  });

  it("replaces a hosted Checkout left open by the flow before NEX-52", async () => {
    await database.insert(billingCheckoutIntents).values({
      id: "00000000-0000-4000-8000-00000000aaaa", organizationId: ORG, planId: "PRO", idempotencyKey: "legacy-hosted-checkout-key",
      requestHash: "0".repeat(64), status: "OPEN", stripeSessionId: "cs_legacy", checkoutUrl: "https://checkout.stripe.com/c/pay/legacy", expiresAt: new Date(NOW.getTime() + 3_600_000),
    });
    const provider = new FakeProvider();
    const result = await createBillingCheckout(actor, "PRO", "checkout-idempotency-after-legacy", dependencies(provider));
    expect(result.clientSecret).toBe("pi_1_secret_synthetic");
    const legacy = (await database.select().from(billingCheckoutIntents)).find((intent) => intent.stripeSessionId === "cs_legacy");
    expect(legacy?.status).toBe("EXPIRED");
  });
});

describe("payment session and saved cards (NEX-52)", () => {
  const actor = { organizationId: ORG, organizationName: "Billing Org", userId: USER, membershipRole: "OWNER" as const };
  const card = (id: string, customerId = "cus_org"): SavedCardSnapshot => ({ id, customerId, brand: "visa", last4: "4242", expMonth: 12, expYear: 2034 });

  it("creates the CustomerSession only for the organization's own customer, and lists its cards for display", async () => {
    await database.update(subscriptions).set({ stripeCustomerId: "cus_org" }).where(eq(subscriptions.organizationId, ORG));
    const provider = new FakeProvider();
    provider.cards = [card("pm_own"), card("pm_foreign", "cus_someone_else")];
    provider.defaultCard = "pm_own";
    const session = await createPaymentSession(actor, { database, provider, now: () => NOW });
    expect(provider.sessionCalls).toEqual(["cus_org"]);
    expect(session.customerSessionClientSecret).toBe("cuss_cus_org_secret_synthetic");
    // A card attached to another Customer never shows up.
    expect(session.cards).toEqual([{ id: "pm_own", brand: "visa", last4: "4242", expMonth: 12, expYear: 2034, isDefault: true, inUse: false }]);
    // Another organization gets its own customer, created on first use.
    await createPaymentSession({ ...actor, organizationId: OTHER_ORG }, { database, provider, now: () => NOW });
    expect(provider.sessionCalls).toEqual(["cus_org", "cus_other"]);
    await expect(createPaymentSession({ ...actor, membershipRole: "MEMBER" }, { database, provider, now: () => NOW })).rejects.toMatchObject({ code: "forbidden" });
    await expect(listSavedCards({ ...actor, membershipRole: "MEMBER" }, { database, provider, now: () => NOW })).rejects.toMatchObject({ code: "forbidden" });
    // Nothing about the cards is written to our database.
    expect(JSON.stringify(await database.select().from(subscriptions))).not.toMatch(/pm_|4242|visa/i);
  });

  it("removes a card only for an owner or admin of the organization that holds it", async () => {
    await database.update(subscriptions).set({ stripeCustomerId: "cus_org" }).where(eq(subscriptions.organizationId, ORG));
    await database.update(subscriptions).set({ stripeCustomerId: "cus_other" }).where(eq(subscriptions.organizationId, OTHER_ORG));
    const provider = new FakeProvider();
    provider.cards = [card("pm_spare")];
    provider.subscriptionsByCustomer.set("cus_other", []);
    const deps = { database, provider, now: () => NOW };
    await expect(removeSavedCard({ ...actor, membershipRole: "MEMBER" }, "pm_spare", deps)).rejects.toMatchObject({ code: "forbidden" });
    // Another organization's customer does not hold it: not found, nothing detached.
    provider.subscriptionsByCustomer.set("cus_other", []);
    const otherProvider = new FakeProvider();
    otherProvider.cards = [];
    await expect(removeSavedCard({ ...actor, organizationId: OTHER_ORG }, "pm_spare", { ...deps, provider: otherProvider })).rejects.toMatchObject({ code: "card_not_found", status: 404 });
    await expect(removeSavedCard(actor, "pm_unknown", deps)).rejects.toMatchObject({ code: "card_not_found" });
    expect(provider.detached).toEqual([]);
    expect(await removeSavedCard({ ...actor, membershipRole: "ADMIN" }, "pm_spare", deps)).toEqual({ removed: true, replacedBy: null });
    expect(provider.detached).toEqual(["pm_spare"]);
  });

  it("never removes the only card paying a live subscription, and hands it over to another card", async () => {
    await database.update(subscriptions).set({ stripeCustomerId: "cus_org" }).where(eq(subscriptions.organizationId, ORG));
    const provider = new FakeProvider();
    provider.cards = [card("pm_main")];
    provider.defaultCard = null;
    provider.subscriptions = [{ id: "sub_plan", customerId: "cus_org", status: "active", cancelAtPeriodEnd: false, priceIds: ["price_pro"], currentPeriodStart: null, currentPeriodEnd: null, defaultPaymentMethodId: "pm_main" }];
    const deps = { database, provider, now: () => NOW };
    expect((await listSavedCards(actor, deps)).cards[0]).toMatchObject({ id: "pm_main", inUse: true });
    await expect(removeSavedCard(actor, "pm_main", deps)).rejects.toMatchObject({ code: "card_in_use", status: 409 });
    expect(provider.detached).toEqual([]);
    provider.cards = [card("pm_main"), card("pm_new")];
    expect(await removeSavedCard(actor, "pm_main", deps)).toEqual({ removed: true, replacedBy: "pm_new" });
    expect(provider.defaultCalls).toEqual([{ customerId: "cus_org", paymentMethodId: "pm_new", subscriptionIds: ["sub_plan"] }]);
    expect(provider.detached).toEqual(["pm_main"]);
  });
});

describe("Stripe reconciliation", () => {
  it("moves from a canceled local subscription to the single new manageable subscription", async () => {
    await database.update(subscriptions).set({
      planId: "FREE", status: "CANCELED", stripeCustomerId: "cus_org", stripeSubscriptionId: "sub_old",
    }).where(eq(subscriptions.organizationId, ORG));
    const provider = new FakeProvider();
    provider.subscriptions = [
      { id: "sub_old", customerId: "cus_org", status: "canceled", cancelAtPeriodEnd: false, priceIds: ["price_pro"], currentPeriodStart: null, currentPeriodEnd: null },
      { id: "sub_new", customerId: "cus_org", status: "active", cancelAtPeriodEnd: false, priceIds: ["price_pro"], currentPeriodStart: new Date("2026-10-01"), currentPeriodEnd: new Date("2026-11-01") },
    ];
    await reconcileStripeCustomer("cus_org", { database, provider, now: () => NOW });
    const row = (await database.select().from(subscriptions).where(eq(subscriptions.organizationId, ORG)))[0]!;
    expect(row).toMatchObject({ planId: "PRO", status: "ACTIVE", stripeSubscriptionId: "sub_new" });
  });

  it("treats incomplete_expired as terminal and permits a fresh Checkout", async () => {
    await database.update(subscriptions).set({ stripeCustomerId: "cus_expired", stripeSubscriptionId: "sub_expired" })
      .where(eq(subscriptions.organizationId, ORG));
    const provider = new FakeProvider();
    provider.subscriptions = [{
      id: "sub_expired", customerId: "cus_expired", status: "incomplete_expired", cancelAtPeriodEnd: false,
      priceIds: ["price_pro"], currentPeriodStart: null, currentPeriodEnd: null,
    }];
    await reconcileStripeCustomer("cus_expired", { database, provider, now: () => NOW });
    expect((await database.select().from(subscriptions).where(eq(subscriptions.organizationId, ORG)))[0]?.status).toBe("CANCELED");
    await createBillingCheckout(
      { organizationId: ORG, organizationName: "Billing Org", userId: USER, membershipRole: "OWNER" },
      "PRO",
      "checkout-idempotency-expired",
      { database, provider, now: () => NOW, randomId: () => "00000000-0000-4000-8000-000000000777" },
    );
    expect(provider.subscriptionCalls).toHaveLength(1);
    expect(provider.portalCalls).toBe(0);
  });

  it("ignores a subscription whose first invoice is unpaid and activates the plan when it is paid (NEX-52)", async () => {
    await database.update(subscriptions).set({ stripeCustomerId: "cus_org" }).where(eq(subscriptions.organizationId, ORG));
    const provider = new FakeProvider();
    const deps = { database, provider, now: () => NOW, randomId: () => "00000000-0000-4000-8000-000000000999" };
    const actor = { organizationId: ORG, organizationName: "Billing Org", userId: USER, membershipRole: "OWNER" as const };
    const started = await createBillingCheckout(actor, "PRO", "checkout-incomplete-key-0001", deps);
    const incomplete: StripeSubscriptionSnapshot = { id: "sub_1", customerId: "cus_org", status: "incomplete", cancelAtPeriodEnd: false, priceIds: ["price_pro"], currentPeriodStart: new Date("2026-10-07"), currentPeriodEnd: new Date("2026-11-07"), checkoutIntentId: started.intentId };
    provider.subscriptions = [incomplete];
    // customer.subscription.created arrives before the payment: nothing is granted or recorded.
    provider.event = { id: "evt_created", type: "customer.subscription.created", created: Math.floor(NOW.getTime() / 1000), data: { object: { id: "sub_1", customer: "cus_org" } } } as unknown as Stripe.Event;
    await processStripeWebhook(Buffer.from("created"), "sig", { database, provider, now: () => NOW });
    let row = (await database.select().from(subscriptions).where(eq(subscriptions.organizationId, ORG)))[0]!;
    expect(row).toMatchObject({ planId: "FREE", stripeSubscriptionId: null });
    expect((await readBillingState(actor, database, NOW)).checkoutAvailable).toBe(true);
    expect((await database.select().from(billingCheckoutIntents))[0]?.status).toBe("OPEN");
    // invoice.paid: the plan becomes active, the intent completes and the kept card is adopted.
    provider.subscriptions = [{ ...incomplete, status: "active" }];
    provider.event = { id: "evt_paid", type: "invoice.paid", created: Math.floor(NOW.getTime() / 1000), data: { object: { id: "in_1", customer: "cus_org" } } } as unknown as Stripe.Event;
    await processStripeWebhook(Buffer.from("paid"), "sig", { database, provider, now: () => NOW });
    row = (await database.select().from(subscriptions).where(eq(subscriptions.organizationId, ORG)))[0]!;
    expect(row).toMatchObject({ planId: "PRO", status: "ACTIVE", stripeSubscriptionId: "sub_1" });
    expect(effectivePlanId(row, NOW)).toBe("PRO");
    expect((await database.select().from(billingCheckoutIntents))[0]?.status).toBe("COMPLETED");
    expect(provider.adoptCalls).toEqual(["sub_1"]);
  });

  it("expires the intent of a subscription Stripe expired unpaid and grants nothing", async () => {
    await database.update(subscriptions).set({ stripeCustomerId: "cus_org" }).where(eq(subscriptions.organizationId, ORG));
    const provider = new FakeProvider();
    const actor = { organizationId: ORG, organizationName: "Billing Org", userId: USER, membershipRole: "OWNER" as const };
    const started = await createBillingCheckout(actor, "PRO", "checkout-expired-key-00001", { database, provider, now: () => NOW, randomId: () => "00000000-0000-4000-8000-000000000998" });
    provider.subscriptions = [{ id: "sub_1", customerId: "cus_org", status: "incomplete_expired", cancelAtPeriodEnd: false, priceIds: ["price_pro"], currentPeriodStart: null, currentPeriodEnd: null, checkoutIntentId: started.intentId }];
    await reconcileStripeCustomer("cus_org", { database, provider, now: () => NOW });
    expect((await database.select().from(billingCheckoutIntents))[0]?.status).toBe("EXPIRED");
    const row = (await database.select().from(subscriptions).where(eq(subscriptions.organizationId, ORG)))[0]!;
    expect(effectivePlanId(row, NOW)).toBe("FREE");
    expect(provider.adoptCalls).toEqual([]);
  });

  it("deduplicates exact webhook bytes and rejects an event ID with another hash", async () => {
    const provider = new FakeProvider();
    provider.event = { id: "evt_hash", type: "ping", created: Math.floor(NOW.getTime() / 1000), data: { object: {} } } as unknown as Stripe.Event;
    const deps = { database, provider, now: () => NOW };
    expect(await processStripeWebhook(Buffer.from("one"), "sig", deps)).toEqual({ duplicate: false });
    expect(await processStripeWebhook(Buffer.from("one"), "sig", deps)).toEqual({ duplicate: true });
    await expect(processStripeWebhook(Buffer.from("two"), "sig", deps)).rejects.toMatchObject({ code: "invalid_webhook" });
  });

  it("verifies genuine Stripe SDK signatures over raw bytes and rejects tampering and stale timestamps", async () => {
    const payload = JSON.stringify({
      id: "evt_signed",
      object: "event",
      api_version: "2026-09-30.endive",
      created: Math.floor(Date.now() / 1_000),
      data: { object: { id: "obj_signed", object: "test_helpers.test_clock" } },
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      type: "ping",
    });
    const signing = new Stripe("sk_test_offline");
    const signature = signing.webhooks.generateTestHeaderString({ payload, secret: "whsec_synthetic" });
    const deps = { database, provider: getBillingProvider(), now: () => NOW };
    expect(await processStripeWebhook(Buffer.from(payload), signature, deps)).toEqual({ duplicate: false });
    await expect(processStripeWebhook(Buffer.from(`${payload} `), signature, deps)).rejects.toMatchObject({ code: "invalid_webhook" });
    await expect(processStripeWebhook(Buffer.from(payload), "t=1,v1=invalid", deps)).rejects.toMatchObject({ code: "invalid_webhook" });
    const stale = signing.webhooks.generateTestHeaderString({ payload, secret: "whsec_synthetic", timestamp: Math.floor(Date.now() / 1_000) - 600 });
    await expect(processStripeWebhook(Buffer.from(payload), stale, deps)).rejects.toMatchObject({ code: "invalid_webhook" });
  });

  it("fences a slower reconciliation so its stale snapshot cannot overwrite a newer result", async () => {
    await database.update(subscriptions).set({ stripeCustomerId: "cus_fence" })
      .where(eq(subscriptions.organizationId, ORG));
    let releaseFirst!: (snapshots: StripeSubscriptionSnapshot[]) => void;
    const firstResult = new Promise<StripeSubscriptionSnapshot[]>((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    const provider = new FakeProvider();
    provider.listSubscriptions = async () => {
      calls += 1;
      if (calls === 1) return firstResult;
      return [{
        id: "sub_newer", customerId: "cus_fence", status: "active", cancelAtPeriodEnd: false,
        priceIds: ["price_business"], currentPeriodStart: new Date("2026-10-01"), currentPeriodEnd: new Date("2026-11-01"),
      }];
    };
    const deps = { database, provider, now: () => NOW };
    const slower = reconcileStripeCustomer("cus_fence", deps);
    while (calls < 1) await new Promise((resolve) => setTimeout(resolve, 0));
    await reconcileStripeCustomer("cus_fence", deps);
    releaseFirst([{
      id: "sub_older", customerId: "cus_fence", status: "active", cancelAtPeriodEnd: false,
      priceIds: ["price_pro"], currentPeriodStart: new Date("2026-10-01"), currentPeriodEnd: new Date("2026-11-01"),
    }]);
    await slower;
    const row = (await database.select().from(subscriptions).where(eq(subscriptions.organizationId, ORG)))[0]!;
    expect(row).toMatchObject({ planId: "BUSINESS", stripeSubscriptionId: "sub_newer", reconciliationVersion: 2 });
  });

  it("preserves the usage row and counters on first paid association, then renews without overlap", async () => {
    await database.update(subscriptions).set({ stripeCustomerId: "cus_period" })
      .where(eq(subscriptions.organizationId, ORG));
    const periodId = "00000000-0000-4000-8000-000000000901";
    await database.insert(usagePeriods).values({
      id: periodId,
      organizationId: ORG,
      periodStart: new Date("2026-10-01"),
      periodEnd: new Date("2026-11-01"),
      limit: 10,
      reserved: 2,
      confirmed: 3,
    });
    const provider = new FakeProvider();
    provider.subscriptions = [{
      id: "sub_period", customerId: "cus_period", status: "active", cancelAtPeriodEnd: false,
      priceIds: ["price_starter"], currentPeriodStart: new Date("2026-10-01"), currentPeriodEnd: new Date("2026-11-01"),
    }];
    await reconcileStripeCustomer("cus_period", { database, provider, now: () => NOW });
    let periods = await database.select().from(usagePeriods);
    expect(periods).toHaveLength(1);
    expect(periods[0]).toMatchObject({ id: periodId, reserved: 2, confirmed: 3, limit: 300 });

    provider.subscriptions = [{
      ...provider.subscriptions[0]!,
      currentPeriodStart: new Date("2026-11-01"),
      currentPeriodEnd: new Date("2026-12-01"),
    }];
    await reconcileStripeCustomer("cus_period", { database, provider, now: () => new Date("2026-11-02") });
    periods = (await database.select().from(usagePeriods)).sort((left, right) => left.periodStart.getTime() - right.periodStart.getTime());
    expect(periods).toHaveLength(2);
    expect(periods[0]).toMatchObject({ id: periodId, reserved: 2, confirmed: 3 });
    expect(periods[0]?.periodEnd).toEqual(periods[1]?.periodStart);
    expect(periods[1]?.periodEnd).toEqual(new Date("2026-12-01"));
  });

  it("continues periodic recovery after one customer fails and backs that customer off", async () => {
    await database.update(subscriptions).set({
      stripeCustomerId: "cus_bad", stripeSubscriptionId: "sub_bad", updatedAt: new Date("2026-10-01"),
    }).where(eq(subscriptions.organizationId, ORG));
    await database.update(subscriptions).set({
      stripeCustomerId: "cus_good", updatedAt: new Date("2026-10-02"),
    }).where(eq(subscriptions.organizationId, OTHER_ORG));
    const provider = new FakeProvider();
    provider.subscriptionsByCustomer.set("cus_bad", [
      { id: "sub_bad", customerId: "cus_bad", status: "active", cancelAtPeriodEnd: false, priceIds: ["price_unknown"], currentPeriodStart: new Date("2026-10-01"), currentPeriodEnd: new Date("2026-11-01") },
    ]);
    provider.subscriptionsByCustomer.set("cus_good", [
      { id: "sub_good", customerId: "cus_good", status: "active", cancelAtPeriodEnd: false, priceIds: ["price_starter"], currentPeriodStart: new Date("2026-10-01"), currentPeriodEnd: new Date("2026-11-01") },
    ]);
    expect(await reconcileStaleSubscriptions({ database, provider, now: () => NOW })).toBe(1);
    const rows = await database.select().from(subscriptions);
    expect(rows.find((row) => row.organizationId === OTHER_ORG)).toMatchObject({ planId: "STARTER", stripeSubscriptionId: "sub_good" });
    expect(rows.find((row) => row.organizationId === ORG)?.updatedAt).toEqual(NOW);
  });

  it("keeps accepted counters on downgrade and reports zero remaining", async () => {
    await database.update(subscriptions).set({ planId: "PRO", status: "PAST_DUE" }).where(eq(subscriptions.organizationId, ORG));
    await database.insert(usagePeriods).values({
      organizationId: ORG, periodStart: new Date("2026-10-01"), periodEnd: new Date("2026-11-01"),
      limit: 100, reserved: 4, confirmed: 16,
    });
    const usage = await readUsageState({ organizationId: ORG }, database, NOW);
    expect(usage.current).toMatchObject({ limit: 10, reserved: 4, confirmed: 16, remaining: 0 });
    const row = (await database.select().from(usagePeriods))[0]!;
    expect(row.limit).toBe(20);
  });
});

describe("API add-on checkout", () => {
  function dependencies(provider: FakeProvider): CheckoutDependencies {
    let id = 0;
    return { database, provider, now: () => NOW, randomId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}` };
  }

  const actor = { organizationId: ORG, organizationName: "Billing Org", userId: USER, membershipRole: "OWNER" as const };
  const paidPlan = {
    planId: "STARTER" as const, status: "ACTIVE" as const, stripeCustomerId: "cus_org", stripeSubscriptionId: "sub_plan",
    currentPeriodStart: new Date("2026-10-01"), currentPeriodEnd: new Date("2026-11-01"),
  };
  const planSnapshot: StripeSubscriptionSnapshot = {
    id: "sub_plan", customerId: "cus_org", status: "active", cancelAtPeriodEnd: false,
    priceIds: ["price_starter"], currentPeriodStart: new Date("2026-10-01"), currentPeriodEnd: new Date("2026-11-01"),
  };
  const setOrg = (values: Partial<typeof subscriptions.$inferInsert>) => database.update(subscriptions).set(values).where(eq(subscriptions.organizationId, ORG));

  it("opens one Checkout for the add-on price on the plan's customer, marked as the add-on", async () => {
    await setOrg(paidPlan);
    const provider = new FakeProvider();
    provider.subscriptions = [planSnapshot];
    const deps = dependencies(provider);
    const first = await createApiAddonCheckout(actor, "addon-idempotency-0001", deps);
    const again = await createApiAddonCheckout(actor, "addon-idempotency-0001", deps);
    const otherKey = await createApiAddonCheckout(actor, "addon-idempotency-0002", deps);
    expect(first).toMatchObject({ confirmation: "payment", clientSecret: "pi_1_secret_synthetic" });
    expect(again).toEqual(first);
    expect(otherKey).toEqual(first);
    expect(provider.portalCalls).toBe(0);
    expect(provider.subscriptionCalls).toHaveLength(1);
    expect(provider.subscriptionCalls[0]?.input).toMatchObject({ customerId: "cus_org", priceId: "price_addon", organizationId: ORG, addon: "API" });
    expect(provider.subscriptionCalls[0]?.idempotencyKey).toMatch(/^uno-subscribe-.+-1$/);
    const intents = await database.select().from(billingCheckoutIntents);
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ planId: null, addon: "API", status: "OPEN", stripeSubscriptionId: "sub_1" });
  });

  it("accepts exactly one checkout target in the request body", () => {
    expect(billingCheckoutRequestSchema.parse({ addon: "API" })).toEqual({ addon: "API" });
    expect(billingCheckoutRequestSchema.parse({ planId: "STARTER" })).toEqual({ planId: "STARTER" });
    for (const invalid of [{}, { addon: "WEBHOOKS" }, { planId: "FREE" }, { planId: "PRO", addon: "API" }, { addon: "API", extra: true }]) {
      expect(billingCheckoutRequestSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("is also sold to administrators and on every paid plan", async () => {
    for (const [index, planId] of (["STARTER", "PRO", "BUSINESS"] as const).entries()) {
      await database.delete(billingCheckoutIntents);
      await setOrg({ ...paidPlan, planId });
      const provider = new FakeProvider();
      provider.subscriptions = [{ ...planSnapshot, priceIds: [`price_${planId.toLowerCase()}`] }];
      await createApiAddonCheckout({ ...actor, membershipRole: "ADMIN" }, `addon-idempotency-plan-${index}`, dependencies(provider));
      expect(provider.subscriptionCalls).toHaveLength(1);
    }
  });

  it("blocks members, bad keys and a different target under the same key before any provider call", async () => {
    await setOrg(paidPlan);
    const provider = new FakeProvider();
    provider.subscriptions = [planSnapshot];
    const deps = dependencies(provider);
    await expect(createApiAddonCheckout({ ...actor, membershipRole: "MEMBER" }, "addon-idempotency-0003", deps)).rejects.toMatchObject({ code: "forbidden", status: 403 });
    await expect(createApiAddonCheckout(actor, null, deps)).rejects.toMatchObject({ code: "invalid_idempotency_key" });
    await expect(createApiAddonCheckout(actor, "short", deps)).rejects.toMatchObject({ code: "invalid_idempotency_key" });
    expect(provider.subscriptionCalls).toHaveLength(0);
    await createApiAddonCheckout(actor, "addon-idempotency-0004", deps);
    await expect(createBillingCheckout(actor, "PRO", "addon-idempotency-0004", deps)).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(provider.subscriptionCalls).toHaveLength(1);
  });

  it("requires a paid plan in force", async () => {
    const provider = new FakeProvider();
    const deps = dependencies(provider);
    await expect(createApiAddonCheckout(actor, "addon-idempotency-0005", deps)).rejects.toMatchObject({ code: "paid_plan_required", status: 409 });
    await setOrg({ ...paidPlan, status: "PAST_DUE" });
    await expect(createApiAddonCheckout(actor, "addon-idempotency-0006", deps)).rejects.toMatchObject({ code: "paid_plan_required" });
    await setOrg({ ...paidPlan, currentPeriodEnd: NOW });
    await expect(createApiAddonCheckout(actor, "addon-idempotency-0007", deps)).rejects.toMatchObject({ code: "paid_plan_required" });
    // A courtesy plan (no Stripe subscription) would be reset to Free by the add-on's reconciliation.
    await setOrg({ ...paidPlan, stripeSubscriptionId: null });
    await expect(createApiAddonCheckout(actor, "addon-idempotency-0007b", deps)).rejects.toMatchObject({ code: "paid_plan_required" });
    expect((await readBillingState(actor, database, NOW)).apiAddon.available).toBe(false);
    expect(provider.subscriptionCalls).toHaveLength(0);
    expect(await database.select().from(billingCheckoutIntents)).toHaveLength(0);
  });

  it("never sells a second add-on, locally or when only Stripe knows about it", async () => {
    await setOrg({ ...paidPlan, apiAddonSubscriptionId: "sub_addon", apiAddonStatus: "ACTIVE", apiAddonCurrentPeriodEnd: new Date("2026-11-01") });
    const provider = new FakeProvider();
    provider.subscriptions = [planSnapshot];
    const deps = dependencies(provider);
    await expect(createApiAddonCheckout(actor, "addon-idempotency-0008", deps)).rejects.toMatchObject({ code: "addon_already_active", status: 409 });
    // A past-due add-on is still a live contract: it is fixed in the portal, not bought again.
    await setOrg({ apiAddonStatus: "PAST_DUE" });
    await expect(createApiAddonCheckout(actor, "addon-idempotency-0009", deps)).rejects.toMatchObject({ code: "addon_already_active" });
    // Stripe already has it but the webhook has not been reconciled yet.
    await setOrg({ apiAddonSubscriptionId: null, apiAddonStatus: null, apiAddonCurrentPeriodEnd: null });
    provider.subscriptions = [planSnapshot, { ...planSnapshot, id: "sub_addon", priceIds: ["price_addon"] }];
    await expect(createApiAddonCheckout(actor, "addon-idempotency-0010", deps)).rejects.toMatchObject({ code: "addon_already_active" });
    expect((await database.select().from(billingCheckoutIntents))[0]).toMatchObject({ addon: "API", status: "FAILED" });
    expect(provider.subscriptionCalls).toHaveLength(0);
    // After a cancellation the add-on can be bought again, reusing the same key.
    await setOrg({ apiAddonSubscriptionId: "sub_addon", apiAddonStatus: "CANCELED", apiAddonCurrentPeriodEnd: null });
    provider.subscriptions = [planSnapshot, { ...planSnapshot, id: "sub_addon", status: "canceled", priceIds: ["price_addon"] }];
    await createApiAddonCheckout(actor, "addon-idempotency-0010", deps);
    expect(provider.subscriptionCalls).toHaveLength(1);
    expect(provider.subscriptionCalls[0]?.idempotencyKey).toMatch(/-2$/);
  });

  it("refuses to sell when the add-on price is missing or does not match the catalog", async () => {
    await setOrg(paidPlan);
    const provider = new FakeProvider();
    provider.subscriptions = [planSnapshot];
    const deps = dependencies(provider);
    const failedIntents = async () => (await database.select().from(billingCheckoutIntents)).filter((intent) => intent.status === "FAILED").length;
    vi.stubEnv("STRIPE_PRICE_API_ADDON", "");
    await expect(createApiAddonCheckout(actor, "addon-idempotency-0011", deps)).rejects.toMatchObject({ code: "addon_unavailable", status: 503 });
    vi.stubEnv("STRIPE_PRICE_API_ADDON", "price_pro");
    await expect(createApiAddonCheckout(actor, "addon-idempotency-0012", deps)).rejects.toMatchObject({ code: "service_unavailable" });
    vi.stubEnv("STRIPE_PRICE_API_ADDON", "price_addon");
    for (const [index, mutate] of [
      () => { provider.prices.price_addon = 4_900; },
      () => { provider.prices.price_addon = 5_000; provider.priceActive = false; },
    ].entries()) {
      mutate();
      await expect(createApiAddonCheckout(actor, `addon-idempotency-price-${index}`, deps)).rejects.toMatchObject({ code: "service_unavailable" });
    }
    expect(provider.subscriptionCalls).toHaveLength(0);
    // Both catalog mismatches reached the price check and closed their own intent.
    expect(await failedIntents()).toBe(2);
    provider.priceActive = true;
    vi.stubEnv("UNO_API_ADDON_PRICE_BRL_CENTS", "6500");
    await expect(createApiAddonCheckout(actor, "addon-idempotency-0013", deps)).rejects.toMatchObject({ code: "service_unavailable" });
    provider.prices.price_addon = 6_500;
    await createApiAddonCheckout(actor, "addon-idempotency-0014", deps);
    expect(provider.subscriptionCalls).toHaveLength(1);
  });

  it("still sends a plan purchase to Checkout when only the add-on subscription is alive", async () => {
    await setOrg({ planId: "FREE", status: "CANCELED", stripeCustomerId: "cus_org", stripeSubscriptionId: null, apiAddonSubscriptionId: "sub_addon", apiAddonStatus: "ACTIVE", apiAddonCurrentPeriodEnd: new Date("2026-11-01") });
    const provider = new FakeProvider();
    provider.subscriptions = [{ ...planSnapshot, id: "sub_addon", priceIds: ["price_addon"] }];
    const result = await createBillingCheckout(actor, "PRO", "addon-idempotency-0015", dependencies(provider));
    expect(result.clientSecret).toBe("pi_1_secret_synthetic");
    expect(provider.portalCalls).toBe(0);
    expect(provider.subscriptionCalls[0]?.input).toMatchObject({ priceId: "price_pro" });
    expect(provider.subscriptionCalls[0]?.input.addon).toBeUndefined();
  });

  it("reports the add-on in the billing state", async () => {
    const owner = { organizationId: ORG, membershipRole: "OWNER" as const };
    const addon = async (role: "OWNER" | "ADMIN" | "MEMBER" = "OWNER") => (await readBillingState({ ...owner, membershipRole: role }, database, NOW)).apiAddon;
    expect(await addon()).toEqual({ name: "API", priceBrlCents: 5_000, active: false, status: null, currentPeriodEnd: null, available: false, inactiveWithoutPaidPlan: false });
    await setOrg(paidPlan);
    expect(await addon()).toMatchObject({ active: false, available: true });
    expect(await addon("ADMIN")).toMatchObject({ available: true });
    expect(await addon("MEMBER")).toMatchObject({ available: false });
    vi.stubEnv("STRIPE_PRICE_API_ADDON", "");
    expect(await addon()).toMatchObject({ available: false });
    vi.stubEnv("STRIPE_PRICE_API_ADDON", "price_addon");
    await setOrg({ apiAddonSubscriptionId: "sub_addon", apiAddonStatus: "ACTIVE", apiAddonCurrentPeriodEnd: new Date("2026-11-01") });
    expect(await addon()).toEqual({ name: "API", priceBrlCents: 5_000, active: true, status: "ACTIVE", currentPeriodEnd: "2026-11-01T00:00:00.000Z", available: false, inactiveWithoutPaidPlan: false });
    await setOrg({ apiAddonStatus: "PAST_DUE" });
    expect(await addon()).toMatchObject({ active: false, status: "PAST_DUE", available: false, inactiveWithoutPaidPlan: false });
    await setOrg({ apiAddonStatus: "ACTIVE", status: "CANCELED" });
    expect(await addon()).toMatchObject({ active: false, available: false, inactiveWithoutPaidPlan: true });
    await setOrg({ status: "ACTIVE", apiAddonStatus: "CANCELED" });
    expect(await addon()).toMatchObject({ active: false, status: "CANCELED", available: true, inactiveWithoutPaidPlan: false });
  });
});

describe("Stripe reconciliation of the API add-on", () => {
  const start = new Date("2026-10-01");
  const end = new Date("2026-11-01");
  const snapshot = (id: string, priceIds: string[], overrides: Partial<StripeSubscriptionSnapshot> = {}): StripeSubscriptionSnapshot => ({
    id, customerId: "cus_org", status: "active", cancelAtPeriodEnd: false, priceIds, currentPeriodStart: start, currentPeriodEnd: end, ...overrides,
  });
  const row = async () => (await database.select().from(subscriptions).where(eq(subscriptions.organizationId, ORG)))[0]!;
  const reconcile = (provider: FakeProvider, now = NOW) => reconcileStripeCustomer("cus_org", { database, provider, now: () => now });

  beforeEach(async () => {
    await database.update(subscriptions).set({ stripeCustomerId: "cus_org" }).where(eq(subscriptions.organizationId, ORG));
  });

  it("a plan-only customer has no add-on", async () => {
    const provider = new FakeProvider();
    provider.subscriptions = [snapshot("sub_plan", ["price_pro"])];
    await reconcile(provider);
    const current = await row();
    expect(current).toMatchObject({ planId: "PRO", status: "ACTIVE", stripeSubscriptionId: "sub_plan", stripePriceId: "price_pro", apiAddonSubscriptionId: null, apiAddonStatus: null, apiAddonCurrentPeriodEnd: null });
    expect(hasApiEntitlement(current, NOW)).toBe(false);
  });

  it("classifies the plan subscription and the separate add-on subscription by their prices", async () => {
    const provider = new FakeProvider();
    const addonEnd = new Date("2026-11-05");
    provider.subscriptions = [snapshot("sub_addon", ["price_addon"], { currentPeriodEnd: addonEnd }), snapshot("sub_plan", ["price_starter"], { cancelAtPeriodEnd: true })];
    await reconcile(provider);
    const current = await row();
    expect(current).toMatchObject({
      planId: "STARTER", status: "ACTIVE", stripeSubscriptionId: "sub_plan", stripePriceId: "price_starter", cancelAtPeriodEnd: true,
      apiAddonSubscriptionId: "sub_addon", apiAddonStatus: "ACTIVE",
    });
    expect(current.currentPeriodEnd).toEqual(end);
    expect(current.apiAddonCurrentPeriodEnd).toEqual(addonEnd);
    expect(hasApiEntitlement(current, NOW)).toBe(true);
    // The plan's quota still follows the plan, not the add-on.
    expect((await database.select().from(usagePeriods))[0]).toMatchObject({ limit: 300 });
  });

  it("follows the add-on through past due, cancellation and removal without touching the plan", async () => {
    const provider = new FakeProvider();
    provider.subscriptions = [snapshot("sub_plan", ["price_pro"]), snapshot("sub_addon", ["price_addon"])];
    await reconcile(provider);
    provider.subscriptions = [snapshot("sub_plan", ["price_pro"]), snapshot("sub_addon", ["price_addon"], { status: "past_due" })];
    await reconcile(provider);
    expect(await row()).toMatchObject({ planId: "PRO", status: "ACTIVE", apiAddonSubscriptionId: "sub_addon", apiAddonStatus: "PAST_DUE" });
    expect(hasApiEntitlement(await row(), NOW)).toBe(false);
    provider.subscriptions = [snapshot("sub_plan", ["price_pro"]), snapshot("sub_addon", ["price_addon"], { status: "canceled", currentPeriodEnd: null })];
    await reconcile(provider);
    expect(await row()).toMatchObject({ planId: "PRO", status: "ACTIVE", stripeSubscriptionId: "sub_plan", apiAddonSubscriptionId: "sub_addon", apiAddonStatus: "CANCELED", apiAddonCurrentPeriodEnd: null });
    expect(hasApiEntitlement(await row(), NOW)).toBe(false);
    // A newer add-on replaces the canceled one.
    provider.subscriptions = [...provider.subscriptions, snapshot("sub_addon_2", ["price_addon"])];
    await reconcile(provider);
    expect(await row()).toMatchObject({ apiAddonSubscriptionId: "sub_addon_2", apiAddonStatus: "ACTIVE" });
    provider.subscriptions = [snapshot("sub_plan", ["price_pro"])];
    await reconcile(provider);
    expect(await row()).toMatchObject({ planId: "PRO", apiAddonSubscriptionId: null, apiAddonStatus: null, apiAddonCurrentPeriodEnd: null });
  });

  it("counts a single subscription that carries a plan price and the add-on price for both", async () => {
    const provider = new FakeProvider();
    provider.subscriptions = [snapshot("sub_both", ["price_business", "price_addon"])];
    await reconcile(provider);
    const current = await row();
    expect(current).toMatchObject({
      planId: "BUSINESS", status: "ACTIVE", stripeSubscriptionId: "sub_both", stripePriceId: "price_business",
      apiAddonSubscriptionId: "sub_both", apiAddonStatus: "ACTIVE",
    });
    expect(current.apiAddonCurrentPeriodEnd).toEqual(end);
    expect(hasApiEntitlement(current, NOW)).toBe(true);
    // Later reconciliations keep following it by id.
    provider.subscriptions = [snapshot("sub_both", ["price_business", "price_addon"], { status: "canceled" })];
    await reconcile(provider);
    expect(await row()).toMatchObject({ planId: "BUSINESS", status: "CANCELED", apiAddonStatus: "CANCELED" });
  });

  it("keeps the add-on paid but useless when the plan is gone, and never treats it as a plan", async () => {
    const provider = new FakeProvider();
    provider.subscriptions = [snapshot("sub_plan", ["price_pro"], { status: "canceled" }), snapshot("sub_addon", ["price_addon"])];
    await database.update(subscriptions).set({ stripeSubscriptionId: "sub_plan" }).where(eq(subscriptions.organizationId, ORG));
    await reconcile(provider);
    const current = await row();
    expect(current).toMatchObject({ planId: "PRO", status: "CANCELED", stripeSubscriptionId: "sub_plan", apiAddonSubscriptionId: "sub_addon", apiAddonStatus: "ACTIVE" });
    expect(effectivePlanId(current, NOW)).toBe("FREE");
    expect(hasApiEntitlement(current, NOW)).toBe(false);
    // Only the add-on left on the customer: the plan becomes Free instead of failing.
    provider.subscriptions = [snapshot("sub_addon", ["price_addon"])];
    await database.update(subscriptions).set({ stripeSubscriptionId: null }).where(eq(subscriptions.organizationId, ORG));
    await reconcile(provider);
    expect(await row()).toMatchObject({ planId: "FREE", status: "CANCELED", stripeSubscriptionId: null, apiAddonSubscriptionId: "sub_addon", apiAddonStatus: "ACTIVE" });
  });

  it("prefers the paying add-on when Stripe holds duplicates, instead of blocking the plan", async () => {
    const provider = new FakeProvider();
    provider.subscriptions = [
      snapshot("sub_plan", ["price_starter"]),
      snapshot("sub_addon_incomplete", ["price_addon"], { status: "incomplete" }),
      snapshot("sub_addon_paid", ["price_addon"]),
    ];
    await reconcile(provider);
    expect(await row()).toMatchObject({ planId: "STARTER", apiAddonSubscriptionId: "sub_addon_paid", apiAddonStatus: "ACTIVE" });
  });

  it("leaves the stored add-on state alone when no add-on price is configured", async () => {
    await database.update(subscriptions).set({ apiAddonSubscriptionId: "sub_addon", apiAddonStatus: "ACTIVE", apiAddonCurrentPeriodEnd: end })
      .where(eq(subscriptions.organizationId, ORG));
    vi.stubEnv("STRIPE_PRICE_API_ADDON", "");
    const provider = new FakeProvider();
    provider.subscriptions = [snapshot("sub_plan", ["price_pro"])];
    await reconcile(provider);
    expect(await row()).toMatchObject({ planId: "PRO", apiAddonSubscriptionId: "sub_addon", apiAddonStatus: "ACTIVE" });
  });

  it("fails closed when the add-on price collides with a plan price", async () => {
    vi.stubEnv("STRIPE_PRICE_API_ADDON", "price_pro");
    const provider = new FakeProvider();
    provider.subscriptions = [snapshot("sub_plan", ["price_pro"])];
    await expect(reconcile(provider)).rejects.toMatchObject({ code: "service_unavailable" });
    expect(await row()).toMatchObject({ planId: "FREE", stripeSubscriptionId: null });
  });

  it("reconciles the add-on from its checkout webhook and completes the add-on intent", async () => {
    await database.update(subscriptions).set({ planId: "PRO", status: "ACTIVE", stripeSubscriptionId: "sub_plan", currentPeriodStart: start, currentPeriodEnd: end })
      .where(eq(subscriptions.organizationId, ORG));
    const provider = new FakeProvider();
    provider.subscriptions = [snapshot("sub_plan", ["price_pro"])];
    const actor = { organizationId: ORG, organizationName: "Billing Org", userId: USER, membershipRole: "OWNER" as const };
    await createApiAddonCheckout(actor, "addon-webhook-key-0001", { database, provider, now: () => NOW, randomId: () => "00000000-0000-4000-8000-000000000888" });
    // While the add-on's first invoice is unpaid it neither grants nor blocks anything.
    provider.subscriptions = [snapshot("sub_plan", ["price_pro"]), { ...snapshot("sub_1", ["price_addon"]), status: "incomplete" }];
    await reconcile(provider);
    expect(await row()).toMatchObject({ planId: "PRO", stripeSubscriptionId: "sub_plan", apiAddonSubscriptionId: null, apiAddonStatus: null });
    provider.subscriptions = [snapshot("sub_plan", ["price_pro"]), snapshot("sub_1", ["price_addon"])];
    provider.event = { id: "evt_addon", type: "invoice.paid", created: Math.floor(NOW.getTime() / 1000), data: { object: { id: "in_addon", customer: "cus_org" } } } as unknown as Stripe.Event;
    expect(await processStripeWebhook(Buffer.from("addon"), "sig", { database, provider, now: () => NOW })).toEqual({ duplicate: false });
    expect(await row()).toMatchObject({ planId: "PRO", stripeSubscriptionId: "sub_plan", apiAddonSubscriptionId: "sub_1", apiAddonStatus: "ACTIVE" });
    expect((await database.select().from(billingCheckoutIntents))[0]).toMatchObject({ addon: "API", status: "COMPLETED", stripeSubscriptionId: "sub_1" });
  });
});
