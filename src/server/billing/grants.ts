import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { billingGrants, getDb, subscriptions, type UnoDatabase } from "@/db";
import { AppError } from "@/lib/errors";
import type { PlanId } from "@/lib/plans";

import { lockOrganizationBilling } from "./entitlements";

const PLAN_RANK: Record<PlanId, number> = { FREE: 0, STARTER: 1, PRO: 2, BUSINESS: 3 };
const DAY_MS = 86_400_000;

export type GrantInput = {
  organizationId: string;
  planId: "STARTER" | "PRO" | "BUSINESS";
  days: number;
  source: "PIX" | "REFERRAL";
  /** Idempotency key: the PIX payment id or the referral cycle key. */
  externalRef: string;
  amountBrlCents?: number;
};

export type GrantResult = { applied: boolean; prepaidPlanId: PlanId; prepaidPeriodEnd: Date | null };

/**
 * Grants prepaid plan days to an organization, idempotently by `externalRef`.
 * Days add on top of any unexpired prepaid period (`max(now, current) + days`);
 * the prepaid plan never downgrades within a period (the higher tier wins).
 * Replaying the same `externalRef` is a no-op that returns the current state.
 *
 * The effective state lives on `subscriptions.prepaid_*`, which reconciliation
 * never overwrites, so this coexists with a Stripe subscription on the same org.
 */
export async function applyGrant(
  input: GrantInput,
  database: UnoDatabase = getDb(),
  now: Date = new Date(),
): Promise<GrantResult> {
  if (!Number.isInteger(input.days) || input.days <= 0) {
    throw new AppError("invalid_request", "A concessão precisa de um número de dias positivo.", 400);
  }
  return database.transaction(async (tx) => {
    await lockOrganizationBilling(input.organizationId, tx);
    const subRows = await tx.select().from(subscriptions)
      .where(eq(subscriptions.organizationId, input.organizationId)).limit(1).for("update");
    const sub = subRows[0];
    if (!sub) throw new AppError("not_found", "Assinatura da organização não encontrada.", 404);

    const existing = await tx.select({ id: billingGrants.id }).from(billingGrants)
      .where(eq(billingGrants.externalRef, input.externalRef)).limit(1);
    if (existing[0]) {
      return { applied: false, prepaidPlanId: sub.prepaidPlanId ?? "FREE", prepaidPeriodEnd: sub.prepaidPeriodEnd };
    }

    const activePlan: PlanId = sub.prepaidPlanId && sub.prepaidPeriodEnd && sub.prepaidPeriodEnd > now
      ? sub.prepaidPlanId
      : "FREE";
    const base = activePlan !== "FREE" && sub.prepaidPeriodEnd ? sub.prepaidPeriodEnd : now;
    const prepaidPeriodEnd = new Date(base.getTime() + input.days * DAY_MS);
    const prepaidPlanId: PlanId = PLAN_RANK[activePlan] >= PLAN_RANK[input.planId] ? activePlan : input.planId;

    await tx.update(subscriptions).set({ prepaidPlanId, prepaidPeriodEnd, updatedAt: now })
      .where(eq(subscriptions.organizationId, input.organizationId));
    await tx.insert(billingGrants).values({
      id: randomUUID(),
      organizationId: input.organizationId,
      planId: input.planId,
      days: input.days,
      source: input.source,
      externalRef: input.externalRef,
      amountBrlCents: input.amountBrlCents ?? null,
      status: "APPLIED",
      appliedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    return { applied: true, prepaidPlanId, prepaidPeriodEnd };
  });
}
