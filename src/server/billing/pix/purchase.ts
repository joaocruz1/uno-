import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, pixCharges, type UnoDatabase } from "@/db";
import { AppError } from "@/lib/errors";
import { paidPlanIdSchema } from "@/lib/billing-model";
import { getPlanCatalog } from "@/lib/plans";
import type { Actor } from "@/server/auth/actor";
import { applyGrant as applyGrantDefault } from "@/server/billing/grants";

import { getPixProvider, type PixProvider } from "./provider";

const CHARGE_EXPIRY_SECONDS = 30 * 60;
const PERIOD_DAYS = { monthly: 30, annual: 365 } as const;

export const createPixPurchaseInputSchema = z.object({
  planId: paidPlanIdSchema,
  period: z.enum(["monthly", "annual"]),
  /** CPF digits only; required by the gateway. */
  cpf: z.string().regex(/^\d{11}$/),
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

function priceFor(planId: CreatePixPurchaseInput["planId"], period: CreatePixPurchaseInput["period"]): number {
  const monthly = getPlanCatalog()[planId].priceBrlCents;
  return period === "annual" ? monthly * 12 : monthly;
}

/** Creates a PIX charge for prepaid plan days and returns the QR to pay. */
export async function createPixPurchase(
  actor: Pick<Actor, "organizationId" | "userId" | "email">,
  rawInput: unknown,
  dependencies: PixPurchaseDependencies = defaults(),
): Promise<PixPurchaseView> {
  const request = createPixPurchaseInputSchema.parse(rawInput);
  const days = PERIOD_DAYS[request.period];
  const amountBrlCents = priceFor(request.planId, request.period);
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
