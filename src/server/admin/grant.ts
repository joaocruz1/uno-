import { and, eq } from "drizzle-orm";

import { getDb, memberships, subscriptions, user, type UnoDatabase } from "@/db";
import { AppError } from "@/lib/errors";
import { planIdSchema, type PlanId } from "@/lib/plans";
import { lockOrganizationBilling } from "@/server/billing/entitlements";

const DAY_MS = 86_400_000;

export type TestGrantInput = { email: string; planId: PlanId; days: number; apiAddon: boolean };
export type TestGrantResult = {
  organizationId: string;
  prepaidPlanId: PlanId;
  prepaidPeriodEnd: string;
  apiAddon: boolean;
};

/**
 * Admin override that unlocks a paid plan (and optionally the API add-on) for an
 * organization, by setting the prepaid and add-on columns directly — no payment,
 * no Stripe. It is a manual test grant, so it writes the columns rather than a
 * billing_grants record: reconciliation never runs for an org without a Stripe
 * subscription, so the override persists. Replaying it just re-sets the columns.
 *
 * The effective plan becomes the higher of the Stripe plan and this prepaid plan
 * (so it coexists with a real subscription), and the API entitlement needs this
 * add-on active, which this sets. For a real, paid entitlement use Checkout.
 */
export async function grantTestEntitlement(input: TestGrantInput, database: UnoDatabase = getDb(), now: Date = new Date()): Promise<TestGrantResult> {
  const planId = planIdSchema.parse(input.planId);
  if (planId === "FREE") throw new AppError("invalid_request", "Escolha um plano pago (Starter, Pro ou Business).", 400);
  if (!Number.isInteger(input.days) || input.days <= 0 || input.days > 3_650) {
    throw new AppError("invalid_request", "Informe um número de dias entre 1 e 3650.", 400);
  }
  const email = input.email.trim().toLowerCase();
  if (!email) throw new AppError("invalid_request", "Informe o e-mail da conta.", 400);

  const users = await database.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
  if (!users[0]) throw new AppError("not_found", "Nenhuma conta com esse e-mail.", 404);
  const owned = await database.select({ organizationId: memberships.organizationId, role: memberships.role })
    .from(memberships).where(eq(memberships.userId, users[0].id));
  const org = owned.find((membership) => membership.role === "OWNER") ?? owned[0];
  if (!org) throw new AppError("not_found", "A conta não pertence a nenhuma organização.", 404);

  const periodEnd = new Date(now.getTime() + input.days * DAY_MS);
  return database.transaction(async (tx) => {
    await lockOrganizationBilling(org.organizationId, tx);
    const existing = await tx.select({ id: subscriptions.id }).from(subscriptions)
      .where(eq(subscriptions.organizationId, org.organizationId)).limit(1).for("update");
    if (!existing[0]) {
      await tx.insert(subscriptions).values({ organizationId: org.organizationId });
    }
    await tx.update(subscriptions).set({
      prepaidPlanId: planId,
      prepaidPeriodEnd: periodEnd,
      ...(input.apiAddon ? { apiAddonStatus: "ACTIVE" as const, apiAddonCurrentPeriodEnd: periodEnd } : {}),
      updatedAt: now,
    }).where(and(eq(subscriptions.organizationId, org.organizationId)));
    return { organizationId: org.organizationId, prepaidPlanId: planId, prepaidPeriodEnd: periodEnd.toISOString(), apiAddon: input.apiAddon };
  });
}
