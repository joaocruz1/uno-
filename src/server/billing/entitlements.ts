import { and, desc, eq, gt, lte, sql } from "drizzle-orm";

import { subscriptions, usagePeriods, type UnoDatabase } from "@/db";
import { AppError } from "@/lib/errors";
import { getPlanCatalog, type PlanDefinition, type PlanId } from "@/lib/plans";
import type { SubscriptionStatus } from "@/lib/billing-model";

export type SubscriptionEntitlement = {
  planId: PlanId;
  status: SubscriptionStatus;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
};

export type EffectivePlan = {
  planId: PlanId;
  plan: PlanDefinition;
  subscription: SubscriptionEntitlement;
};

export function effectivePlanId(subscription: SubscriptionEntitlement | undefined, now = new Date()): PlanId {
  if (!subscription) return "FREE";
  if (subscription.planId === "FREE") return "FREE";
  if (subscription.status !== "ACTIVE" && subscription.status !== "TRIALING") return "FREE";
  if (!subscription.currentPeriodStart || !subscription.currentPeriodEnd) return "FREE";
  if (subscription.currentPeriodStart > now || subscription.currentPeriodEnd <= now) return "FREE";
  return subscription.planId;
}

export async function loadEffectivePlan(
  organizationId: string,
  database: UnoDatabase,
  now = new Date(),
): Promise<EffectivePlan> {
  const rows = await database.select({
    planId: subscriptions.planId,
    status: subscriptions.status,
    currentPeriodStart: subscriptions.currentPeriodStart,
    currentPeriodEnd: subscriptions.currentPeriodEnd,
  }).from(subscriptions).where(eq(subscriptions.organizationId, organizationId)).limit(1);
  const subscription: SubscriptionEntitlement = rows[0] ?? {
    planId: "FREE",
    status: "ACTIVE",
    currentPeriodStart: null,
    currentPeriodEnd: null,
  };
  const planId = effectivePlanId(subscription, now);
  return { planId, plan: getPlanCatalog()[planId], subscription };
}

export function effectivePlanFromSubscription(
  subscription: SubscriptionEntitlement | undefined,
  now = new Date(),
): EffectivePlan {
  const resolved = subscription ?? {
    planId: "FREE" as const,
    status: "ACTIVE" as const,
    currentPeriodStart: null,
    currentPeriodEnd: null,
  };
  const planId = effectivePlanId(resolved, now);
  return { planId, plan: getPlanCatalog()[planId], subscription: resolved };
}

export function desiredUsagePeriod(now: Date, entitlement: EffectivePlan) {
  if (entitlement.planId !== "FREE" && entitlement.subscription.currentPeriodStart && entitlement.subscription.currentPeriodEnd) {
    return { start: entitlement.subscription.currentPeriodStart, end: entitlement.subscription.currentPeriodEnd };
  }
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

export async function lockCurrentUsagePeriod(
  organizationId: string,
  entitlement: EffectivePlan,
  now: Date,
  database: UnoDatabase,
  options: { alignPeriodEnd?: boolean } = {},
) {
  const desired = desiredUsagePeriod(now, entitlement);
  const current = await database.select().from(usagePeriods).where(and(
    eq(usagePeriods.organizationId, organizationId),
    lte(usagePeriods.periodStart, now),
    gt(usagePeriods.periodEnd, now),
  )).orderBy(desc(usagePeriods.periodStart)).limit(1).for("update");
  const row = current[0];
  if (row) {
    const accountingLimit = Math.max(entitlement.plan.monthlyLimit, row.reserved + row.confirmed);
    const periodEnd = options.alignPeriodEnd && desired.end > row.periodEnd ? desired.end : row.periodEnd;
    if (row.limit !== accountingLimit || row.periodEnd.getTime() !== periodEnd.getTime()) {
      await database.update(usagePeriods).set({ limit: accountingLimit, periodEnd, updatedAt: now }).where(eq(usagePeriods.id, row.id));
    }
    return { ...row, limit: accountingLimit, periodEnd };
  }

  const latest = await database.select({ periodEnd: usagePeriods.periodEnd }).from(usagePeriods)
    .where(eq(usagePeriods.organizationId, organizationId)).orderBy(desc(usagePeriods.periodEnd)).limit(1).for("update");
  const start = latest[0]?.periodEnd && latest[0].periodEnd > desired.start ? latest[0].periodEnd : desired.start;
  const end = desired.end > start ? desired.end : new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  await database.insert(usagePeriods).values({
    organizationId,
    periodStart: start,
    periodEnd: end,
    limit: entitlement.plan.monthlyLimit,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing({ target: [usagePeriods.organizationId, usagePeriods.periodStart, usagePeriods.periodEnd] });
  const inserted = await database.select().from(usagePeriods).where(and(
    eq(usagePeriods.organizationId, organizationId),
    eq(usagePeriods.periodStart, start),
    eq(usagePeriods.periodEnd, end),
  )).limit(1).for("update");
  if (!inserted[0]) throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
  return inserted[0];
}

export function assertUsageAvailable(
  period: Pick<typeof usagePeriods.$inferSelect, "reserved" | "confirmed">,
  effectiveLimit: number,
  units = 1,
): void {
  if (period.reserved + period.confirmed + units > effectiveLimit) {
    throw new AppError("quota_exceeded", "A organização atingiu a cota mensal.", 403);
  }
}

export async function lockOrganizationBilling(organizationId: string, database: Pick<UnoDatabase, "execute">): Promise<void> {
  await database.execute(sql`select pg_advisory_xact_lock(hashtextextended(${organizationId}, 19))`);
}
