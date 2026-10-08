import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { apiKeys, organizations, subscriptions, user, type UnoDatabase } from "@/db";
import { createApiKey, listApiKeys, requireApiActor, revokeApiKey } from "@/server/api-keys";

const USER = "00000000-0000-4000-8000-000000000001";
const ORG = "00000000-0000-4000-8000-000000000101";
const OTHER_ORG = "00000000-0000-4000-8000-000000000102";
const NOW = new Date("2026-10-07T12:00:00.000Z");
const ADDON = { apiAddonSubscriptionId: null, apiAddonStatus: "ACTIVE" as const, apiAddonCurrentPeriodEnd: new Date("2026-11-01") };
const pglite = new PGlite();
const database = drizzle(pglite, { schema }) as unknown as UnoDatabase;

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
  await database.insert(user).values({ id: USER, name: "API", email: "api@example.test", emailVerified: true });
  await database.insert(organizations).values([
    { id: ORG, name: "API Org", slug: "api-org", ownerUserId: USER },
    { id: OTHER_ORG, name: "Other", slug: "api-other", ownerUserId: USER },
  ]);
});

beforeEach(async () => {
  await database.delete(apiKeys);
  await database.delete(subscriptions);
  await database.insert(subscriptions).values([
    { organizationId: ORG, planId: "PRO", status: "ACTIVE", currentPeriodStart: new Date("2026-10-01"), currentPeriodEnd: new Date("2026-11-01"), ...ADDON },
    { organizationId: OTHER_ORG, planId: "BUSINESS", status: "ACTIVE", currentPeriodStart: new Date("2026-10-01"), currentPeriodEnd: new Date("2026-11-01"), ...ADDON },
  ]);
});

afterAll(async () => { await pglite.close(); });

const owner = { organizationId: ORG, userId: USER, membershipRole: "OWNER" as const };

describe("API key lifecycle", () => {
  it("shows the random secret once and authenticates only its hash", async () => {
    const created = await createApiKey(owner, { name: "ERP principal" }, database, NOW);
    expect(created.key).toMatch(/^uno_[A-Za-z0-9_-]{43}$/);
    const stored = (await database.select().from(apiKeys).where(eq(apiKeys.id, created.id)))[0]!;
    expect(stored.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(created.key);
    expect(await listApiKeys(owner, database)).toEqual({ items: [{ ...created, key: undefined }] });
    const headers = new Headers({ authorization: `Bearer ${created.key}` });
    await expect(requireApiActor(headers, database, NOW)).resolves.toEqual({ organizationId: ORG, apiKeyId: created.id, planId: "PRO" });
  });

  it("applies revocation, expiration, downgrade, roles, and tenant scope", async () => {
    await expect(createApiKey({ ...owner, membershipRole: "MEMBER" }, { name: "Blocked" }, database, NOW))
      .rejects.toMatchObject({ code: "forbidden" });
    const expired = await createApiKey(owner, { name: "Expiring", expiresAt: new Date(NOW.getTime() + 1_000).toISOString() }, database, NOW);
    await expect(requireApiActor(new Headers({ authorization: `Bearer ${expired.key}` }), database, new Date(NOW.getTime() + 2_000)))
      .rejects.toMatchObject({ code: "unauthorized" });

    const active = await createApiKey(owner, { name: "Active" }, database, NOW);
    await expect(revokeApiKey({ organizationId: OTHER_ORG, membershipRole: "OWNER" }, active.id, database, NOW))
      .rejects.toMatchObject({ code: "not_found" });
    await revokeApiKey(owner, active.id, database, NOW);
    await expect(requireApiActor(new Headers({ authorization: `Bearer ${active.key}` }), database, NOW))
      .rejects.toMatchObject({ code: "unauthorized" });

    const downgraded = await createApiKey(owner, { name: "Downgrade" }, database, NOW);
    await database.update(subscriptions).set({ planId: "FREE", currentPeriodStart: null, currentPeriodEnd: null })
      .where(eq(subscriptions.organizationId, ORG));
    await expect(requireApiActor(new Headers({ authorization: `Bearer ${downgraded.key}` }), database, NOW))
      .rejects.toMatchObject({ code: "plan_required" });
    await expect(listApiKeys(owner, database)).resolves.toMatchObject({ items: expect.any(Array) });
    await expect(revokeApiKey(owner, downgraded.id, database, NOW)).resolves.toBeUndefined();
  });

  it("requires the API add-on on a paid plan in force, whatever the plan", async () => {
    const paid = { planId: "BUSINESS" as const, status: "ACTIVE" as const, currentPeriodStart: new Date("2026-10-01"), currentPeriodEnd: new Date("2026-11-01") };
    const created = await createApiKey(owner, { name: "Entitlement" }, database, NOW);
    const headers = new Headers({ authorization: `Bearer ${created.key}` });
    const set = (values: Partial<typeof subscriptions.$inferInsert>) => database.update(subscriptions).set(values).where(eq(subscriptions.organizationId, ORG));

    // Paid plan without the add-on: no API, even on Business.
    await set({ ...paid, apiAddonSubscriptionId: null, apiAddonStatus: null, apiAddonCurrentPeriodEnd: null });
    await expect(requireApiActor(headers, database, NOW)).rejects.toMatchObject({ code: "plan_required", status: 403, message: expect.stringContaining("adicional de API") });
    await expect(createApiKey(owner, { name: "Blocked" }, database, NOW)).rejects.toMatchObject({ code: "plan_required" });

    // Starter with the add-on: API is available.
    await set({ ...paid, planId: "STARTER", ...ADDON });
    await expect(requireApiActor(headers, database, NOW)).resolves.toMatchObject({ planId: "STARTER" });

    // Add-on past due, canceled or expired: no API.
    for (const addon of [
      { apiAddonStatus: "PAST_DUE" as const },
      { apiAddonStatus: "CANCELED" as const },
      { apiAddonCurrentPeriodEnd: NOW },
    ]) {
      await set({ ...paid, ...ADDON, ...addon });
      await expect(requireApiActor(headers, database, NOW)).rejects.toMatchObject({ code: "plan_required" });
    }

    // Add-on paid up but the plan is past due: no API.
    await set({ ...paid, status: "PAST_DUE", ...ADDON });
    await expect(requireApiActor(headers, database, NOW)).rejects.toMatchObject({ code: "plan_required" });
  });
});
