import { eq } from "drizzle-orm";

import { getDb, subscriptions, type UnoDatabase } from "@/db";
import type { BillingView, UsageView } from "@/lib/billing-model";
import { getPlanCatalog } from "@/lib/plans";
import type { Actor } from "@/server/auth/actor";

import { billingProviderConfigured, publicBillingPlans } from "./config";
import { effectivePlanId, lockCurrentUsagePeriod, lockOrganizationBilling } from "./entitlements";

const FREE_SUBSCRIPTION = {
  planId: "FREE" as const,
  status: "ACTIVE" as const,
  currentPeriodStart: null,
  currentPeriodEnd: null,
};

export async function readBillingState(
  actor: Pick<Actor, "organizationId" | "membershipRole">,
  database: UnoDatabase = getDb(),
  now = new Date(),
): Promise<BillingView> {
  const rows = await database.select().from(subscriptions)
    .where(eq(subscriptions.organizationId, actor.organizationId)).limit(1);
  const subscription = rows[0] ?? FREE_SUBSCRIPTION;
  const canManage = actor.membershipRole === "OWNER" || actor.membershipRole === "ADMIN";
  const configured = billingProviderConfigured();
  const manageableSubscription = Boolean(subscription.stripeSubscriptionId) && subscription.status !== "CANCELED";
  return {
    planId: subscription.planId,
    effectivePlanId: effectivePlanId(subscription, now),
    status: subscription.status,
    currentPeriodStart: subscription.currentPeriodStart?.toISOString() ?? null,
    currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd ?? false,
    checkoutAvailable: canManage && configured && !manageableSubscription,
    portalAvailable: canManage && configured && Boolean(subscription.stripeCustomerId),
    plans: publicBillingPlans(),
  };
}

export async function readUsageState(
  actor: Pick<Actor, "organizationId">,
  database: UnoDatabase = getDb(),
  now = new Date(),
): Promise<UsageView> {
  return database.transaction(async (transaction) => {
    await lockOrganizationBilling(actor.organizationId, transaction);
    const subscriptionsRows = await transaction.select({
      planId: subscriptions.planId,
      status: subscriptions.status,
      currentPeriodStart: subscriptions.currentPeriodStart,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
    }).from(subscriptions).where(eq(subscriptions.organizationId, actor.organizationId)).limit(1).for("update");
    const subscription = subscriptionsRows[0] ?? FREE_SUBSCRIPTION;
    const planId = effectivePlanId(subscription, now);
    const plan = getPlanCatalog()[planId];
    const current = await lockCurrentUsagePeriod(actor.organizationId, { planId, plan, subscription }, now, transaction);
    return {
      current: {
        limit: plan.monthlyLimit,
        reserved: current.reserved,
        confirmed: current.confirmed,
        remaining: Math.max(0, plan.monthlyLimit - current.reserved - current.confirmed),
        periodStart: current.periodStart.toISOString(),
        periodEnd: current.periodEnd.toISOString(),
      },
    };
  });
}
