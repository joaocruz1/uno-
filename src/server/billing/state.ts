import { eq } from "drizzle-orm";

import { getDb, subscriptions, type UnoDatabase } from "@/db";
import type { BillingView, UsageView } from "@/lib/billing-model";
import { getApiAddon } from "@/lib/plans";
import type { Actor } from "@/server/auth/actor";

import { apiAddonConfigured, billingProviderConfigured, publicBillingPlans } from "./config";
import {
  apiAddonActive,
  effectivePlanFromSubscription,
  effectivePlanId,
  FREE_ENTITLEMENT,
  lockCurrentUsagePeriod,
  lockOrganizationBilling,
  subscriptionEntitlementColumns,
} from "./entitlements";

export async function readBillingState(
  actor: Pick<Actor, "organizationId" | "membershipRole">,
  database: UnoDatabase = getDb(),
  now = new Date(),
): Promise<BillingView> {
  const rows = await database.select().from(subscriptions)
    .where(eq(subscriptions.organizationId, actor.organizationId)).limit(1);
  const subscription = rows[0];
  const entitlement = subscription ?? FREE_ENTITLEMENT;
  const canManage = actor.membershipRole === "OWNER" || actor.membershipRole === "ADMIN";
  const configured = billingProviderConfigured();
  const manageableSubscription = Boolean(subscription?.stripeSubscriptionId) && entitlement.status !== "CANCELED";
  const effective = effectivePlanId(entitlement, now);
  const paidPlan = effective !== "FREE";
  const addonPaid = apiAddonActive(entitlement, now);
  // A live add-on subscription (even past due) is managed in the portal, never bought twice.
  const addonManageable = Boolean(subscription?.apiAddonSubscriptionId) && entitlement.apiAddonStatus !== "CANCELED";
  return {
    planId: entitlement.planId,
    effectivePlanId: effective,
    status: entitlement.status,
    currentPeriodStart: entitlement.currentPeriodStart?.toISOString() ?? null,
    currentPeriodEnd: entitlement.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
    checkoutAvailable: canManage && configured && !manageableSubscription,
    portalAvailable: canManage && configured && Boolean(subscription?.stripeCustomerId),
    plans: publicBillingPlans(),
    apiAddon: {
      name: getApiAddon().name,
      priceBrlCents: getApiAddon().priceBrlCents,
      active: paidPlan && addonPaid,
      status: entitlement.apiAddonStatus,
      currentPeriodEnd: entitlement.apiAddonCurrentPeriodEnd?.toISOString() ?? null,
      available: canManage && apiAddonConfigured() && paidPlan && Boolean(subscription?.stripeSubscriptionId) && !addonManageable,
      inactiveWithoutPaidPlan: addonPaid && !paidPlan,
    },
  };
}

export async function readUsageState(
  actor: Pick<Actor, "organizationId">,
  database: UnoDatabase = getDb(),
  now = new Date(),
): Promise<UsageView> {
  return database.transaction(async (transaction) => {
    await lockOrganizationBilling(actor.organizationId, transaction);
    const subscriptionsRows = await transaction.select(subscriptionEntitlementColumns)
      .from(subscriptions).where(eq(subscriptions.organizationId, actor.organizationId)).limit(1).for("update");
    const entitlement = effectivePlanFromSubscription(subscriptionsRows[0], now);
    const plan = entitlement.plan;
    const current = await lockCurrentUsagePeriod(actor.organizationId, entitlement, now, transaction);
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
