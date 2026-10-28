import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, pixCharges, subscriptions, type UnoDatabase } from "@/db";
import { AppError } from "@/lib/errors";
import { isValidCpf } from "@/lib/cpf";
import { paidPlanIdSchema, type PaidPlanId } from "@/lib/billing-model";
import { getPlanCatalog } from "@/lib/plans";
import type { Actor } from "@/server/auth/actor";
import { listPriceQuote } from "@/server/billing/coupons";
import { applyGrant as applyGrantDefault } from "@/server/billing/grants";

import { getPixProvider, type PixProvider } from "./provider";

const CHARGE_EXPIRY_SECONDS = 30 * 60;
const PERIOD_DAYS = { monthly: 30, annual: 365 } as const;

export const createPixPurchaseInputSchema = z.object({
  planId: paidPlanIdSchema,
  period: z.enum(["monthly", "annual"]),
  /** CPF digits only; required by the gateway. */
  cpf: z.string().regex(/^\d{11}$/).refine(isValidCpf, "CPF inválido."),
}).strict();

export type CreatePixPurchaseInput = z.infer<typeof createPixPurchaseInputSchema>;
export type PixPurchaseView = {
  id: string;
  status: "PENDING" | "APPROVED" | "EXPIRED" | "FAILED";
  amountBrlCents: number;
  qrCode: string | null;
  qrCodeBase64: string | null;
  expiresAt: string | null;
};

export type PixPurchaseDependencies = {
  database: UnoDatabase;
  provider: PixProvider;
  applyGrant: typeof applyGrantDefault;
  now(): Date;
  randomId(): string;
};

function defaults(): PixPurchaseDependencies {
  return { database: getDb(), provider: getPixProvider(), applyGrant: applyGrantDefault, now: () => new Date(), randomId: randomUUID };
}

/**
 * The organization has never paid before: no approved PIX charge and no Stripe
 * subscription. Only then the first-month promo reaches a PIX purchase, so the
 * cheap first month cannot be bought again every 30 days.
 */
async function isFirstPurchase(organizationId: string, database: UnoDatabase): Promise<boolean> {
  const paid = await database.select({ id: pixCharges.id }).from(pixCharges)
    .where(and(eq(pixCharges.organizationId, organizationId), eq(pixCharges.status, "APPROVED"))).limit(1);
  if (paid[0]) return false;
  const rows = await database.select({ stripeSubscriptionId: subscriptions.stripeSubscriptionId }).from(subscriptions)
    .where(eq(subscriptions.organizationId, organizationId)).limit(1);
  return !rows[0]?.stripeSubscriptionId;
}

/**
 * What 30 days of a plan cost by PIX for this organization, decided here and
 * never by the client: the first-month price on the first purchase, the
 * regular monthly price after that. Coupons are card-only (their use is
 * tracked on the Stripe checkout), so they do not apply to PIX.
 */
export async function pixMonthlyAmountBrlCents(planId: PaidPlanId, organizationId: string, database: UnoDatabase = getDb()): Promise<number> {
  const quote = listPriceQuote(planId);
  if (quote.appliedDiscount !== "first_month") return quote.regularBrlCents;
  return (await isFirstPurchase(organizationId, database)) ? quote.firstPaymentBrlCents : quote.regularBrlCents;
}

/** The PIX amounts the checkout shows, one per paid plan. */
export async function pixMonthlyAmounts(organizationId: string, database: UnoDatabase = getDb()): Promise<Record<PaidPlanId, number>> {
  const [STARTER, PRO, BUSINESS] = await Promise.all((["STARTER", "PRO", "BUSINESS"] as const).map((planId) => pixMonthlyAmountBrlCents(planId, organizationId, database)));
  return { STARTER: STARTER!, PRO: PRO!, BUSINESS: BUSINESS! };
}

/** Whether a PIX gateway is configured in this installation. */
export function pixAvailable(): boolean {
  try {
    getPixProvider();
    return true;
  } catch {
    return false;
  }
}

async function priceFor(planId: CreatePixPurchaseInput["planId"], period: CreatePixPurchaseInput["period"], organizationId: string, database: UnoDatabase): Promise<number> {
  if (period === "monthly") return pixMonthlyAmountBrlCents(planId, organizationId, database);
  return getPlanCatalog()[planId].priceBrlCents * 12;
}

/** Creates a PIX charge for prepaid plan days and returns the QR to pay. */
export async function createPixPurchase(
  actor: Pick<Actor, "organizationId" | "userId" | "email">,
  rawInput: unknown,
  dependencies: PixPurchaseDependencies = defaults(),
): Promise<PixPurchaseView> {
  const request = createPixPurchaseInputSchema.parse(rawInput);
  const days = PERIOD_DAYS[request.period];
  const amountBrlCents = await priceFor(request.planId, request.period, actor.organizationId, dependencies.database);
  const id = dependencies.randomId();
  const now = dependencies.now();

  await dependencies.database.insert(pixCharges).values({
    id,
    organizationId: actor.organizationId,
    createdByUserId: actor.userId,
    planId: request.planId,
    days,
    amountBrlCents,
    status: "PENDING",
    createdAt: now,
    updatedAt: now,
  });

  const charge = await dependencies.provider.createCharge({
    amountBrlCents,
    description: `UNO ${request.planId} ${days} dias`,
    externalReference: id,
    payerEmail: actor.email,
    payerCpf: request.cpf,
    expiresInSeconds: CHARGE_EXPIRY_SECONDS,
  });

  await dependencies.database.update(pixCharges).set({
    providerChargeId: charge.providerChargeId,
    qrCode: charge.qrCode,
    qrCodeBase64: charge.qrCodeBase64,
    expiresAt: charge.expiresAt,
    updatedAt: dependencies.now(),
  }).where(eq(pixCharges.id, id));

  return {
    id,
    status: "PENDING",
    amountBrlCents,
    qrCode: charge.qrCode,
    qrCodeBase64: charge.qrCodeBase64,
    expiresAt: charge.expiresAt.toISOString(),
  };
}

/**
 * Reconsults a PIX payment at the gateway and, once approved with a matching
 * amount, grants the prepaid days through `applyGrant` (idempotent by payment
 * id). Safe to call repeatedly from the webhook.
 */
export async function confirmPixPayment(
  providerChargeId: string,
  dependencies: PixPurchaseDependencies = defaults(),
): Promise<void> {
  const payment = await dependencies.provider.getPayment(providerChargeId);
  const rows = await dependencies.database.select().from(pixCharges).where(eq(pixCharges.providerChargeId, providerChargeId)).limit(1);
  const charge = rows[0];
  if (!charge) return;
  if (charge.status === "APPROVED") return;

  const now = dependencies.now();
  if (payment.status === "approved") {
    if (payment.amountBrlCents !== charge.amountBrlCents) {
      await dependencies.database.update(pixCharges).set({ status: "FAILED", updatedAt: now }).where(eq(pixCharges.id, charge.id));
      return;
    }
    if (charge.planId === "FREE") return;
    const externalRef = `pix:${providerChargeId}`;
    await dependencies.applyGrant({
      organizationId: charge.organizationId,
      planId: charge.planId,
      days: charge.days,
      source: "PIX",
      externalRef,
      amountBrlCents: charge.amountBrlCents,
    }, dependencies.database, now);
    await dependencies.database.update(pixCharges).set({
      status: "APPROVED", approvedAt: now, grantExternalRef: externalRef, updatedAt: now,
    }).where(eq(pixCharges.id, charge.id));
    return;
  }
  if (payment.status === "expired") {
    await dependencies.database.update(pixCharges).set({ status: "EXPIRED", updatedAt: now }).where(eq(pixCharges.id, charge.id));
  } else if (payment.status === "failed") {
    await dependencies.database.update(pixCharges).set({ status: "FAILED", updatedAt: now }).where(eq(pixCharges.id, charge.id));
  }
}

export async function readPixPurchase(
  organizationId: string,
  chargeId: string,
  database: UnoDatabase = getDb(),
): Promise<PixPurchaseView> {
  const rows = await database.select().from(pixCharges).where(eq(pixCharges.id, chargeId)).limit(1);
  const charge = rows[0];
  if (!charge || charge.organizationId !== organizationId) throw new AppError("not_found", "Cobrança não encontrada.", 404);
  return {
    id: charge.id,
    status: charge.status,
    amountBrlCents: charge.amountBrlCents,
    qrCode: charge.qrCode,
    qrCodeBase64: charge.qrCodeBase64,
    expiresAt: charge.expiresAt?.toISOString() ?? null,
  };
}

/**
 * What the checkout polls: the stored charge, after one more authoritative
 * read of the payment at the gateway while it is still pending. The webhook
 * normally settles it first; this makes the dialog independent of a late or
 * misconfigured webhook. `confirmPixPayment` is idempotent and checks the
 * amount, so calling it here grants nothing the webhook would not.
 */
export async function reconcilePixPurchase(
  organizationId: string,
  chargeId: string,
  dependencies: Pick<PixPurchaseDependencies, "database"> & Partial<PixPurchaseDependencies> = { database: getDb() },
): Promise<PixPurchaseView> {
  const current = await readPixPurchase(organizationId, chargeId, dependencies.database);
  if (current.status !== "PENDING") return current;
  const rows = await dependencies.database.select({ providerChargeId: pixCharges.providerChargeId }).from(pixCharges).where(eq(pixCharges.id, chargeId)).limit(1);
  const providerChargeId = rows[0]?.providerChargeId;
  if (!providerChargeId) return current;
  try {
    await confirmPixPayment(providerChargeId, {
      database: dependencies.database,
      provider: dependencies.provider ?? getPixProvider(),
      applyGrant: dependencies.applyGrant ?? applyGrantDefault,
      now: dependencies.now ?? (() => new Date()),
      randomId: dependencies.randomId ?? randomUUID,
    });
  } catch (error) {
    // The gateway is unreachable for a moment: report the stored state and let the next poll retry.
    console.log(JSON.stringify({ event: "pix.reconcile.failed", chargeId, message: error instanceof Error ? error.message : "unknown" }));
  }
  return readPixPurchase(organizationId, chargeId, dependencies.database);
}
