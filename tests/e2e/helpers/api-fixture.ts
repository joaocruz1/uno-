import "node:process";

import { and, eq } from "drizzle-orm";

import { apiKeys, getDb, organizations, subscriptions, user } from "@/db";

try { process.loadEnvFile(".env.local"); } catch { /* the runner may already provide the required environment */ }

export async function promoteSyntheticPro(email: string): Promise<{ organizationId: string }> {
  if (!/^uno-api-e2e-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}@example\.test$/i.test(email)) {
    throw new Error("unexpected synthetic API fixture identity");
  }
  const database = getDb();
  const account = await database.select({ userId: user.id }).from(user).where(eq(user.email, email)).limit(1);
  if (!account[0]) throw new Error("synthetic API user not found");
  const organization = await database.select({ organizationId: organizations.id }).from(organizations).where(eq(organizations.ownerUserId, account[0].userId)).limit(1);
  if (!organization[0]) throw new Error("synthetic API organization not found");
  const now = new Date();
  await database.update(subscriptions).set({
    planId: "PRO",
    status: "ACTIVE",
    currentPeriodStart: new Date(now.getTime() - 60_000),
    currentPeriodEnd: new Date(now.getTime() + 86_400_000),
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripePriceId: null,
  }).where(eq(subscriptions.organizationId, organization[0].organizationId));
  return organization[0];
}

export async function restoreSyntheticFree(organizationId: string): Promise<void> {
  const database = getDb();
  await database.delete(apiKeys).where(and(eq(apiKeys.organizationId, organizationId), eq(apiKeys.name, "syntheticERP")));
  await database.update(subscriptions).set({ planId: "FREE", status: "ACTIVE", currentPeriodStart: null, currentPeriodEnd: null }).where(eq(subscriptions.organizationId, organizationId));
}
