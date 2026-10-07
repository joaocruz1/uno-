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
import { getPlanCatalog, PlanConfigurationError } from "@/lib/plans";
import { createBillingCheckout, processStripeWebhook, readUsageState, reconcileStaleSubscriptions, reconcileStripeCustomer } from "@/server/billing";
import type { CheckoutDependencies } from "@/server/billing/checkout";
import { effectivePlanId } from "@/server/billing/entitlements";
import { getBillingProvider, type BillingProvider, type StripeSubscriptionSnapshot } from "@/server/billing/stripe";

const USER = "00000000-0000-4000-8000-000000000001";
const ORG = "00000000-0000-4000-8000-000000000101";
const OTHER_ORG = "00000000-0000-4000-8000-000000000102";
const NOW = new Date("2026-10-07T12:00:00.000Z");

const pglite = new PGlite();
const database = drizzle(pglite, { schema }) as unknown as UnoDatabase;

class FakeProvider implements BillingProvider {
  checkoutCalls: Array<{ idempotencyKey: string; input: Parameters<BillingProvider["createCheckout"]>[0] }> = [];
  portalCalls = 0;
  subscriptions: StripeSubscriptionSnapshot[] = [];
  subscriptionsByCustomer = new Map<string, StripeSubscriptionSnapshot[]>();
  event: Stripe.Event = { id: "evt_default", type: "ping", created: Math.floor(NOW.getTime() / 1000), data: { object: {} } } as unknown as Stripe.Event;

  async createCustomer() { return { id: "cus_org" }; }
  async retrievePrice(priceId: string) {
    return { id: priceId, active: true, currency: "brl", unitAmount: 4_900, recurringInterval: "month", recurringIntervalCount: 1 };
  }
  async createCheckout(input: Parameters<BillingProvider["createCheckout"]>[0], idempotencyKey: string) {
    this.checkoutCalls.push({ input, idempotencyKey });
    return {
      id: `cs_${this.checkoutCalls.length}`,
      url: `https://checkout.stripe.com/c/pay/${this.checkoutCalls.length}`,
      expiresAt: new Date(NOW.getTime() + 60 * 60_000),
    };
  }
  async createPortal() { this.portalCalls += 1; return { url: "https://billing.stripe.com/p/session/test" }; }
  async listSubscriptions(customerId: string) { return this.subscriptionsByCustomer.get(customerId) ?? this.subscriptions; }
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

  it("rejects invalid runtime plan overrides and keeps the engine file cap", () => {
    expect(() => getPlanCatalog({ NODE_ENV: "test", UNO_PLAN_PRO_MAX_FILE_MB: "101" })).toThrow(PlanConfigurationError);
    expect(getPlanCatalog({ NODE_ENV: "test", UNO_PLAN_PRO_MONTHLY_LIMIT: "2500" }).PRO.monthlyLimit).toBe(2500);
  });
});

describe("billing checkout", () => {
  function dependencies(provider: FakeProvider): CheckoutDependencies {
    let id = 0;
    return { database, provider, now: () => NOW, randomId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}` };
  }

  const actor = { organizationId: ORG, organizationName: "Billing Org", userId: USER, membershipRole: "OWNER" as const };

  it("persists and reuses one open Checkout across idempotency keys", async () => {
    const provider = new FakeProvider();
    const deps = dependencies(provider);
    const first = await createBillingCheckout(actor, "PRO", "checkout-idempotency-0001", deps);
    const sameKey = await createBillingCheckout(actor, "PRO", "checkout-idempotency-0001", deps);
    const otherKey = await createBillingCheckout(actor, "PRO", "checkout-idempotency-0002", deps);
    expect(sameKey).toEqual(first);
    expect(otherKey).toEqual(first);
    expect(provider.checkoutCalls).toHaveLength(1);
    expect(provider.checkoutCalls[0]?.input.integrationIdentifier).toMatch(/^uno_checkout_[a-z]{8}$/);
    expect((await database.select().from(billingCheckoutIntents))).toHaveLength(1);
  });

  it("uses a new provider attempt after a Checkout expires", async () => {
    const provider = new FakeProvider();
    const deps = dependencies(provider);
    await createBillingCheckout(actor, "PRO", "checkout-idempotency-0003", deps);
    await database.update(billingCheckoutIntents).set({ expiresAt: new Date(NOW.getTime() - 1) });
    await createBillingCheckout(actor, "PRO", "checkout-idempotency-0003", deps);
    expect(provider.checkoutCalls.map((call) => call.idempotencyKey)).toEqual([
      expect.stringMatching(/-1$/), expect.stringMatching(/-2$/),
    ]);
    expect(provider.checkoutCalls[0]?.input.integrationIdentifier).not.toBe(provider.checkoutCalls[1]?.input.integrationIdentifier);
  });

  it("blocks members before calling the provider", async () => {
    const provider = new FakeProvider();
    await expect(createBillingCheckout({ ...actor, membershipRole: "MEMBER" }, "PRO", "checkout-idempotency-0004", dependencies(provider)))
      .rejects.toMatchObject({ code: "forbidden" });
    expect(provider.checkoutCalls).toHaveLength(0);
  });

  it("opens the portal when Stripe already has a manageable contract missing from local state", async () => {
    await database.update(subscriptions).set({ stripeCustomerId: "cus_org", status: "CANCELED" })
      .where(eq(subscriptions.organizationId, ORG));
    const provider = new FakeProvider();
    provider.subscriptions = [{
      id: "sub_remote", customerId: "cus_org", status: "active", cancelAtPeriodEnd: false,
      priceIds: ["price_unknown_legacy"], currentPeriodStart: new Date("2026-10-01"), currentPeriodEnd: new Date("2026-11-01"),
    }];
    const result = await createBillingCheckout(actor, "PRO", "checkout-idempotency-0005", dependencies(provider));
    expect(result.url).toContain("billing.stripe.com");
    expect(provider.portalCalls).toBe(1);
    expect(provider.checkoutCalls).toHaveLength(0);
    expect((await database.select().from(billingCheckoutIntents))[0]?.status).toBe("COMPLETED");
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
    expect(provider.checkoutCalls).toHaveLength(1);
    expect(provider.portalCalls).toBe(0);
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
