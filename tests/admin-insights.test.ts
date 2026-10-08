import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import type { UnoDatabase } from "@/db";
import { adminActivity, adminApiKeys, adminConnections, adminCustomers, adminFinance } from "@/server/admin";

const id = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const NOW = new Date("2026-10-07T15:00:00.000Z");
const pglite = new PGlite();
const database = drizzle(pglite, { schema }) as unknown as UnoDatabase;
const previous = process.env.ADMIN_EMAILS;

beforeAll(async () => {
  const directory = fileURLToPath(new URL("../drizzle", import.meta.url));
  for (const name of (await readdir(directory)).filter((file) => /^\d{4}_.*\.sql$/.test(file)).sort()) {
    for (const statement of (await readFile(`${directory}/${name}`, "utf8")).split("--> statement-breakpoint")) if (statement.trim()) await pglite.exec(statement);
  }
  process.env.ADMIN_EMAILS = "admin@example.test";
  await database.insert(schema.user).values([
    { id: id(1), name: "Admin", email: "admin@example.test", emailVerified: true, platformRole: "ADMIN" },
    { id: id(2), name: "Member", email: "member@example.test", emailVerified: true },
  ]);
  await database.insert(schema.organizations).values([
    { id: id(101), name: "Loja Paga", slug: "paga", ownerUserId: id(2) },
    { id: id(102), name: "Loja Cortesia", slug: "cortesia", ownerUserId: id(2) },
    { id: id(103), name: "Loja Free", slug: "free", ownerUserId: id(2) },
  ]);
  await database.insert(schema.subscriptions).values([
    { organizationId: id(101), planId: "PRO", status: "ACTIVE", stripeSubscriptionId: "sub_synthetic_1", cancelAtPeriodEnd: true, apiAddonSubscriptionId: "sub_synthetic_addon_1", apiAddonStatus: "ACTIVE", apiAddonCurrentPeriodEnd: new Date(NOW.getTime() + 86_400_000) },
    // Courtesy plan with a courtesy add-on (no provider link): excluded from revenue.
    { organizationId: id(102), planId: "BUSINESS", status: "ACTIVE", apiAddonStatus: "ACTIVE", apiAddonCurrentPeriodEnd: new Date(NOW.getTime() + 86_400_000) },
    // Canceled add-on on a Free organization: not revenue either.
    { organizationId: id(103), planId: "FREE", status: "ACTIVE", apiAddonSubscriptionId: "sub_synthetic_addon_3", apiAddonStatus: "CANCELED" },
  ]);
  await database.insert(schema.templates).values({ id: id(10), key: "mercado-livre", version: "1.0.0", displayName: "Mercado Livre", engineVersion: "0.1.0", definition: {} });
  await database.insert(schema.apiKeys).values([
    { id: id(201), organizationId: id(101), name: "ERP", prefix: "uno_synthetic", keyHash: "a".repeat(64), lastUsedAt: NOW },
    { id: id(202), organizationId: id(101), name: "Antiga", prefix: "uno_revoked01", keyHash: "b".repeat(64), revokedAt: NOW },
  ]);
  const conversion = (suffix: number, organizationId: string, status: "completed" | "failed", source: "api" | "dashboard", extra: Record<string, unknown> = {}) => ({
    id: id(suffix), organizationId, templateId: id(10), templateVersion: "1.0.0", engineVersion: "0.1.0", status, source,
    outputPreset: "100x150", outputWidthMm: "100", outputHeightMm: "150", inputObjectKey: `k/${suffix}`, sourceByteLength: 10,
    originalFileName: "segredo-do-cliente.pdf", createdAt: new Date(NOW.getTime() - 3_600_000), ...extra,
  });
  await database.insert(schema.conversions).values([
    conversion(301, id(101), "completed", "api", { apiKeyId: id(201), processingTimeMs: 1_000, productHeader: { quantity: 1, title: "x" } }),
    conversion(302, id(101), "completed", "dashboard", { processingTimeMs: 2_000 }),
    conversion(303, id(103), "failed", "dashboard", { errorCode: "unsupported_template" }),
  ]);
});

afterAll(async () => {
  if (previous === undefined) delete process.env.ADMIN_EMAILS; else process.env.ADMIN_EMAILS = previous;
  await pglite.close();
});

describe("admin business insights", () => {
  it("is denied to anyone without both platform credentials", async () => {
    for (const read of [adminFinance, adminCustomers, adminApiKeys, adminActivity, adminConnections]) {
      await expect(read({ userId: id(2) }, database)).rejects.toMatchObject({ code: "forbidden" });
    }
  });

  it("counts revenue only for billed subscriptions", async () => {
    const finance = await adminFinance({ userId: id(1) }, database, NOW);
    // Pro (R$ 15,99) plus its Stripe-linked API add-on (R$ 50,00).
    expect(finance).toMatchObject({ estimatedMrrBrlCents: 1_599 + 5_000, payingOrganizations: 1, unbilledPaidOrganizations: 1, freeOrganizations: 1, cancelingAtPeriodEnd: 1 });
    expect(finance.byPlan.find((plan) => plan.planId === "PRO")).toMatchObject({ priceBrlCents: 1_599, subscriptions: 1, mrrBrlCents: 1_599 });
    expect(finance.apiAddon).toEqual({ name: "API", priceBrlCents: 5_000, subscriptions: 1, mrrBrlCents: 5_000 });
    expect(Object.fromEntries(finance.recentPaid.map((row) => [row.organizationName, row.apiAddon]))).toEqual({ "Loja Paga": true, "Loja Cortesia": false });
    expect(finance.recentPaid.map((row) => row.organizationName).sort()).toEqual(["Loja Cortesia", "Loja Paga"]);
  });

  it("ranks customers, lists keys without secrets and breaks activity down by channel", async () => {
    const customers = await adminCustomers({ userId: id(1) }, database, NOW);
    expect(customers[0]).toMatchObject({ organizationName: "Loja Paga", completed30d: 2, viaApi30d: 1, viaDashboard30d: 1, activeApiKeys: 1 });
    const keys = await adminApiKeys({ userId: id(1) }, database, NOW);
    expect(keys.map((key) => [key.name, key.state, key.conversions30d])).toEqual([["ERP", "active", 1], ["Antiga", "revoked", 0]]);
    const activity = await adminActivity({ userId: id(1) }, database, NOW);
    expect(activity).toMatchObject({ total30d: 3, completed30d: 2, withProductHeader: 1, averageProcessingMs: 1_500 });
    expect(activity.days).toHaveLength(14);
    expect(activity.bySource).toEqual(expect.arrayContaining([{ key: "dashboard", total: 2, completed: 1 }, { key: "api", total: 1, completed: 1 }]));
    const everything = JSON.stringify([customers, keys, activity, await adminFinance({ userId: id(1) }, database, NOW), await adminConnections({ userId: id(1) }, database)]);
    for (const secret of ["segredo-do-cliente", "a".repeat(64), "sub_synthetic_1", "k/301"]) expect(everything.includes(secret)).toBe(false);
  });
});
