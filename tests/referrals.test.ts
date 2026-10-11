import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { billingGrants, conversions, organizations, referralCodes, referrals, subscriptions, templates, user, type UnoDatabase } from "@/db";
import {
  claimReferralReward,
  ensureReferralCode,
  linkReferral,
  referralProgress,
} from "@/server/billing/referrals";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const DAY = 86_400_000;
const REFERRER = "00000000-0000-4000-8000-0000000000a0";
const REFERRED = ["0000000000a1", "0000000000a2", "0000000000a3"].map((s) => `00000000-0000-4000-8000-00${s}`);
const TEMPLATE = "00000000-0000-4000-8000-000000000201";

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

/** A completed conversion in a referred user's personal org (id = user id). */
async function convert(referredUserId: string) {
  await database.insert(conversions).values({
    id: randomUUID(), organizationId: referredUserId, templateId: TEMPLATE, templateVersion: "1.0.0", engineVersion: "0.1.0",
    status: "completed", source: "dashboard", outputPreset: "100x150", outputWidthMm: "100", outputHeightMm: "150",
    inputObjectKey: `organizations/${referredUserId}/conversion-inputs/${randomUUID()}.pdf`, sourceByteLength: 1_000,
    queuedAt: NOW, completedAt: NOW, createdAt: NOW, updatedAt: NOW,
  });
}

beforeAll(async () => {
  await applyMigrations();
  const all = [REFERRER, ...REFERRED];
  await database.insert(user).values(all.map((id, index) => ({ id, name: `U${index}`, email: `u${index}@example.test`, emailVerified: true })));
  // Personal organization id equals the user id.
  await database.insert(organizations).values(all.map((id, index) => ({ id, name: `O${index}`, slug: `o${index}`, ownerUserId: id })));
  await database.insert(templates).values({
    id: TEMPLATE, key: "mercado-livre", version: "1.0.0", displayName: "Mercado Livre", engineVersion: "0.1.0",
    status: "RELEASED", releasedAt: NOW, definition: { releasedSizes: [] },
  });
});

beforeEach(async () => {
  await database.delete(billingGrants);
  await database.delete(conversions);
  await database.delete(referrals);
  await database.delete(referralCodes);
  await database.delete(subscriptions);
  await database.insert(subscriptions).values({ organizationId: REFERRER, planId: "FREE", status: "ACTIVE" });
});

afterAll(async () => { await pglite.close(); });

describe("referral linking", () => {
  it("creates a stable code and links a referred user once", async () => {
    const code = await ensureReferralCode(REFERRER, database);
    expect(await ensureReferralCode(REFERRER, database)).toBe(code);

    expect(await linkReferral({ code, referredUserId: REFERRED[0]! }, database)).toEqual({ linked: true });
    expect(await linkReferral({ code, referredUserId: REFERRED[0]! }, database)).toEqual({ linked: false }); // duplicate
    expect(await linkReferral({ code, referredUserId: REFERRER }, database)).toEqual({ linked: false }); // self
    expect(await linkReferral({ code: "nope", referredUserId: REFERRED[1]! }, database)).toEqual({ linked: false }); // unknown code
  });
});

describe("referral progress and reward", () => {
  async function linkAll() {
    const code = await ensureReferralCode(REFERRER, database);
    for (const id of REFERRED) await linkReferral({ code, referredUserId: id }, database);
  }

  it("counts an active referral only after the referred converts", async () => {
    await linkAll();
    let progress = await referralProgress(REFERRER, database);
    expect(progress).toMatchObject({ signups: 3, active: 0, goal: 3, eligible: false });

    await convert(REFERRED[0]!);
    progress = await referralProgress(REFERRER, database);
    expect(progress.active).toBe(1);
  });

  it("does not reward below the goal", async () => {
    await linkAll();
    await convert(REFERRED[0]!);
    expect(await claimReferralReward(REFERRER, database, NOW)).toEqual({ rewarded: false });
    expect((await database.select().from(subscriptions).where(eq(subscriptions.organizationId, REFERRER)))[0]!.prepaidPlanId).toBeNull();
  });

  it("grants the bonus once the goal is reached, idempotently", async () => {
    await linkAll();
    for (const id of REFERRED) await convert(id);
    const progress = await referralProgress(REFERRER, database);
    expect(progress).toMatchObject({ active: 3, eligible: true, rewarded: false });

    expect(await claimReferralReward(REFERRER, database, NOW)).toEqual({ rewarded: true });
    const sub = (await database.select().from(subscriptions).where(eq(subscriptions.organizationId, REFERRER)))[0]!;
    expect(sub.prepaidPlanId).toBe("PRO");
    expect(sub.prepaidPeriodEnd!.getTime()).toBe(NOW.getTime() + 5 * DAY);

    await claimReferralReward(REFERRER, database, new Date(NOW.getTime() + DAY)); // replay later
    expect(await database.select().from(billingGrants)).toHaveLength(1);
    expect((await referralProgress(REFERRER, database)).rewarded).toBe(true);
  });
});
