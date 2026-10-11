import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { billingGrants, organizations, subscriptions, user, type UnoDatabase } from "@/db";
import {
  desiredUsagePeriod,
  effectivePlanFromSubscription,
  effectivePlanId,
  type SubscriptionEntitlement,
} from "@/server/billing/entitlements";
import { applyGrant } from "@/server/billing/grants";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const DAY = 86_400_000;
const USER = "00000000-0000-4000-8000-000000000001";
const ORG = "00000000-0000-4000-8000-000000000101";

const pglite = new PGlite();
const database = drizzle(pglite, { schema }) as unknown as UnoDatabase;

async function applyMigrations() {
  const directory = fileURLToPath(new URL("../drizzle", import.meta.url));
  const names = (await readdir(directory)).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
  for (const name of names) {
    const migration = await readFile(`${directory}/${name}`, "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await pglite.exec(statement);
    }
  }
}

function entitlement(overrides: Partial<SubscriptionEntitlement>): SubscriptionEntitlement {
  return {
    planId: "FREE", status: "ACTIVE", currentPeriodStart: null, currentPeriodEnd: null,
    apiAddonStatus: null, apiAddonCurrentPeriodEnd: null, prepaidPlanId: null, prepaidPeriodEnd: null,
    ...overrides,
  };
}

beforeAll(async () => {
  await applyMigrations();
  await database.insert(user).values({ id: USER, name: "Grant", email: "grant@example.test", emailVerified: true });
  await database.insert(organizations).values({ id: ORG, name: "Grant", slug: "grant", ownerUserId: USER });
});

beforeEach(async () => {
  await database.delete(billingGrants);
  await database.delete(subscriptions);
  await database.insert(subscriptions).values({ organizationId: ORG, planId: "FREE", status: "ACTIVE" });
});

afterAll(async () => { await pglite.close(); });

describe("applyGrant", () => {
  it("credits prepaid plan days and makes the plan effective", async () => {
    const result = await applyGrant({ organizationId: ORG, planId: "STARTER", days: 30, source: "PIX", externalRef: "pix:1", amountBrlCents: 2500 }, database, NOW);
    expect(result.applied).toBe(true);
    expect(result.prepaidPlanId).toBe("STARTER");
    expect(result.prepaidPeriodEnd!.getTime()).toBe(NOW.getTime() + 30 * DAY);
    const sub = (await database.select().from(subscriptions).where(eq(subscriptions.organizationId, ORG)))[0]!;
    expect(effectivePlanId({ planId: sub.planId, status: sub.status, currentPeriodStart: sub.currentPeriodStart, currentPeriodEnd: sub.currentPeriodEnd, prepaidPlanId: sub.prepaidPlanId, prepaidPeriodEnd: sub.prepaidPeriodEnd }, NOW)).toBe("STARTER");
  });

  it("is idempotent per externalRef", async () => {
    await applyGrant({ organizationId: ORG, planId: "STARTER", days: 30, source: "PIX", externalRef: "pix:dup" }, database, NOW);
    const second = await applyGrant({ organizationId: ORG, planId: "STARTER", days: 30, source: "PIX", externalRef: "pix:dup" }, database, NOW);
    expect(second.applied).toBe(false);
    expect(second.prepaidPeriodEnd!.getTime()).toBe(NOW.getTime() + 30 * DAY);
    expect(await database.select().from(billingGrants).where(eq(billingGrants.organizationId, ORG))).toHaveLength(1);
  });

  it("adds days on top of an unexpired prepaid period", async () => {
    await applyGrant({ organizationId: ORG, planId: "STARTER", days: 30, source: "PIX", externalRef: "pix:a" }, database, NOW);
    const second = await applyGrant({ organizationId: ORG, planId: "STARTER", days: 30, source: "PIX", externalRef: "pix:b" }, database, NOW);
    expect(second.prepaidPeriodEnd!.getTime()).toBe(NOW.getTime() + 60 * DAY);
  });

  it("never downgrades the plan within a period", async () => {
    await applyGrant({ organizationId: ORG, planId: "PRO", days: 30, source: "PIX", externalRef: "pix:pro" }, database, NOW);
    const second = await applyGrant({ organizationId: ORG, planId: "STARTER", days: 30, source: "REFERRAL", externalRef: "ref:1" }, database, NOW);
    expect(second.prepaidPlanId).toBe("PRO");
    expect(second.prepaidPeriodEnd!.getTime()).toBe(NOW.getTime() + 60 * DAY);
  });
});

describe("effectivePlanId with prepaid", () => {
  it("ignores an expired prepaid grant", () => {
    expect(effectivePlanId({ planId: "FREE", status: "ACTIVE", currentPeriodStart: null, currentPeriodEnd: null, prepaidPlanId: "PRO", prepaidPeriodEnd: new Date(NOW.getTime() - DAY) }, NOW)).toBe("FREE");
  });

  it("takes the higher of Stripe and prepaid", () => {
    const stripeStarter = { planId: "STARTER" as const, status: "ACTIVE" as const, currentPeriodStart: new Date(NOW.getTime() - DAY), currentPeriodEnd: new Date(NOW.getTime() + DAY) };
    expect(effectivePlanId({ ...stripeStarter, prepaidPlanId: "PRO", prepaidPeriodEnd: new Date(NOW.getTime() + DAY) }, NOW)).toBe("PRO");
    expect(effectivePlanId({ ...stripeStarter, prepaidPlanId: "FREE", prepaidPeriodEnd: null }, NOW)).toBe("STARTER");
  });

  it("gives a prepaid-only org a civil-month quota period", () => {
    const resolved = effectivePlanFromSubscription(entitlement({ prepaidPlanId: "PRO", prepaidPeriodEnd: new Date(NOW.getTime() + 30 * DAY) }), NOW);
    expect(resolved.planId).toBe("PRO");
    const period = desiredUsagePeriod(NOW, resolved);
    expect(period.start.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(period.end.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });
});
