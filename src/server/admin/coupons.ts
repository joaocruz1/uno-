import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { coupons, getDb, type UnoDatabase } from "@/db";
import { paidPlanIdSchema, type PaidPlanId } from "@/lib/billing-model";
import { AppError } from "@/lib/errors";
import { billingProviderConfigured, stripePriceId } from "@/server/billing/config";
import { COUPON_CODE, couponLabel, normalizeCouponCode } from "@/server/billing/coupons";
import { getBillingProvider, type BillingProvider } from "@/server/billing/stripe";
import { writeAudit } from "@/server/organizations/audit";

import { assertPlatformAdmin, type AdminIdentity } from "./access";

/*
 * Discount coupons managed by the platform admin (NEX-51). Each coupon is a
 * Stripe Coupon plus a Promotion Code with the same code, created through the
 * API; UNO keeps the record, enforces plan applicability and counts usage.
 */

export const couponCreateSchema = z.object({
  code: z.string().trim().transform(normalizeCouponCode).pipe(z.string().regex(COUPON_CODE, "Use de 3 a 40 letras, números, - ou _.")),
  kind: z.enum(["percent", "amount"]),
  percentOff: z.number().int().min(1).max(100).optional(),
  amountOffBrlCents: z.number().int().min(1).max(10_000_000).optional(),
  duration: z.enum(["once", "forever", "repeating"]),
  durationInMonths: z.number().int().min(1).max(36).optional(),
  planIds: z.array(paidPlanIdSchema).max(3).optional(),
  maxRedemptions: z.number().int().min(1).max(1_000_000).optional(),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
}).strict().superRefine((value, context) => {
  if (value.kind === "percent" && value.percentOff === undefined) context.addIssue({ code: "custom", path: ["percentOff"], message: "Informe o percentual." });
  if (value.kind === "amount" && value.amountOffBrlCents === undefined) context.addIssue({ code: "custom", path: ["amountOffBrlCents"], message: "Informe o valor do desconto." });
  if (value.duration === "repeating" && value.durationInMonths === undefined) context.addIssue({ code: "custom", path: ["durationInMonths"], message: "Informe por quantos meses." });
});

export type CouponCreateInput = z.input<typeof couponCreateSchema>;

export type AdminCoupon = {
  id: string;
  code: string;
  label: string;
  discountType: "PERCENT" | "AMOUNT";
  percentOff: number | null;
  amountOffBrlCents: number | null;
  duration: "once" | "forever" | "repeating";
  durationInMonths: number | null;
  planIds: PaidPlanId[];
  maxRedemptions: number | null;
  expiresAt: string | null;
  active: boolean;
  createdAt: string;
  /** Plan Checkouts completed with this coupon applied. */
  checkoutsCompleted: number;
  /** Organizations whose plan subscription carries this coupon now. */
  subscriptions: number;
};

type Database = Pick<UnoDatabase, "select" | "execute" | "insert" | "update" | "transaction">;

export type CouponAdminDependencies = { database: Database; provider: BillingProvider; now(): Date; randomId(): string };

function defaults(): CouponAdminDependencies {
  return { database: getDb(), provider: getBillingProvider(), now: () => new Date(), randomId: randomUUID };
}

type CouponRow = typeof coupons.$inferSelect;

function asDuration(value: string): AdminCoupon["duration"] {
  return value === "forever" || value === "repeating" ? value : "once";
}

function view(row: CouponRow, usage: { completed: number; subscriptions: number }): AdminCoupon {
  const duration = asDuration(row.duration);
  return {
    id: row.id,
    code: row.code,
    label: couponLabel({ percentOff: row.percentOff, amountOff: row.amountOffBrlCents, duration, durationInMonths: row.durationInMonths }),
    discountType: row.discountType === "AMOUNT" ? "AMOUNT" : "PERCENT",
    percentOff: row.percentOff,
    amountOffBrlCents: row.amountOffBrlCents,
    duration,
    durationInMonths: row.durationInMonths,
    planIds: row.planIds,
    maxRedemptions: row.maxRedemptions,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    checkoutsCompleted: usage.completed,
    subscriptions: usage.subscriptions,
  };
}

async function usageByCoupon(database: Pick<UnoDatabase, "execute">): Promise<Map<string, { completed: number; subscriptions: number }>> {
  const rows = await database.execute<{ id: string; completed: string; subscriptions: string }>(sql`
    select c.id,
      (select count(*) from billing_checkout_intents i where i.coupon_id = c.id and i.status = 'COMPLETED') as completed,
      (select count(*) from subscriptions s where s.applied_coupon_id = c.id) as subscriptions
    from coupons c`);
  return new Map(rows.rows.map((row) => [String(row.id), { completed: Number(row.completed ?? 0), subscriptions: Number(row.subscriptions ?? 0) }]));
}

/** Every coupon, newest first, with its usage. */
export async function listAdminCoupons(identity: AdminIdentity, database: Database = getDb()): Promise<AdminCoupon[]> {
  await assertPlatformAdmin(identity, database);
  const rows = await database.select().from(coupons).orderBy(sql`${coupons.createdAt} desc`).limit(500);
  const usage = await usageByCoupon(database);
  return rows.map((row) => view(row, usage.get(row.id) ?? { completed: 0, subscriptions: 0 }));
}

/** Creates the Stripe Coupon + Promotion Code, then the local record and its audit entry. */
export async function createAdminCoupon(identity: AdminIdentity, raw: unknown, dependencies: CouponAdminDependencies = defaults()): Promise<AdminCoupon> {
  await assertPlatformAdmin(identity, dependencies.database);
  const input = couponCreateSchema.parse(raw);
  const now = dependencies.now();
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && expiresAt <= now) throw new AppError("invalid_request", "A validade precisa ser uma data futura.", 400);
  if (!billingProviderConfigured()) throw new AppError("billing_not_configured", "A cobrança ainda não está configurada para esta instalação.", 409);
  const existing = await dependencies.database.select({ id: coupons.id }).from(coupons).where(eq(coupons.code, input.code)).limit(1);
  if (existing[0]) throw new AppError("coupon_exists", "Já existe um cupom com esse código.", 409);

  const id = dependencies.randomId();
  const percentOff = input.kind === "percent" ? input.percentOff! : null;
  const amountOffBrlCents = input.kind === "amount" ? input.amountOffBrlCents! : null;
  const durationInMonths = input.duration === "repeating" ? input.durationInMonths! : null;
  const planIds = [...new Set(input.planIds ?? [])];
  // A plan-restricted coupon is also restricted on Stripe, by the plans' Products,
  // so it never discounts another plan after a swap or through the portal.
  let productIds: string[];
  try {
    productIds = [...new Set(await Promise.all(planIds.map(async (planId) => {
      const productId = (await dependencies.provider.retrievePrice(stripePriceId(planId))).productId;
      if (!productId) throw new Error("price_without_product");
      return productId;
    })))];
  } catch {
    throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
  }
  let created: { couponId: string; promotionCodeId: string };
  try {
    created = await dependencies.provider.createCouponWithCode({
      code: input.code, percentOff, amountOffBrlCents, duration: input.duration, durationInMonths,
      maxRedemptions: input.maxRedemptions ?? null, expiresAt, unoCouponId: id, productIds,
    }, `uno-coupon-${id}`);
  } catch {
    // Stripe refuses a Promotion Code whose code is already used in the account.
    throw new AppError("coupon_provider_rejected", "A Stripe recusou o cupom. Confira se o código já existe na conta da Stripe.", 409);
  }
  let row: CouponRow;
  try {
    row = await dependencies.database.transaction(async (transaction) => {
      const inserted = await transaction.insert(coupons).values({
        id, code: input.code, stripeCouponId: created.couponId, stripePromotionCodeId: created.promotionCodeId,
        discountType: percentOff !== null ? "PERCENT" : "AMOUNT", percentOff, amountOffBrlCents,
        duration: input.duration, durationInMonths, planIds,
        maxRedemptions: input.maxRedemptions ?? null, expiresAt, active: true,
        createdByUserId: identity.userId, createdAt: now, updatedAt: now,
      }).returning();
      await writeAudit(transaction, {
        organizationId: null, actorUserId: identity.userId, actorType: "platform_admin",
        action: "coupon.created", resourceType: "coupon", resourceId: id,
        changes: { code: input.code, percentOff, amountOffBrlCents, duration: input.duration, durationInMonths, plans: planIds.join(",") || "ALL", maxRedemptions: input.maxRedemptions ?? null, expiresAt: expiresAt?.toISOString() ?? null },
      }, now);
      return inserted[0]!;
    });
  } catch (error) {
    // Never leave a live Promotion Code that UNO does not know about.
    await dependencies.provider.setPromotionCodeActive(created.promotionCodeId, false, `uno-coupon-${id}-orphan`).catch(() => undefined);
    throw error;
  }
  return view(row, { completed: 0, subscriptions: 0 });
}

/** Turns a coupon on or off here and on its Stripe Promotion Code. Idempotent. */
export async function setAdminCouponActive(identity: AdminIdentity, couponId: string, active: boolean, dependencies: CouponAdminDependencies = defaults()): Promise<AdminCoupon> {
  await assertPlatformAdmin(identity, dependencies.database);
  const rows = await dependencies.database.select().from(coupons).where(eq(coupons.id, couponId)).limit(1);
  const current = rows[0];
  if (!current) throw new AppError("not_found", "Cupom não encontrado.", 404);
  const usage = (await usageByCoupon(dependencies.database)).get(current.id) ?? { completed: 0, subscriptions: 0 };
  if (current.active === active) return view(current, usage);
  if (!billingProviderConfigured()) throw new AppError("billing_not_configured", "A cobrança ainda não está configurada para esta instalação.", 409);
  try {
    await dependencies.provider.setPromotionCodeActive(current.stripePromotionCodeId, active, `uno-coupon-${current.id}-${active ? "on" : "off"}-${current.updatedAt.getTime()}`);
  } catch {
    throw new AppError("service_unavailable", "Serviço temporariamente indisponível.", 503);
  }
  const now = dependencies.now();
  const updated = await dependencies.database.transaction(async (transaction) => {
    const changed = await transaction.update(coupons).set({ active, updatedAt: now })
      .where(and(eq(coupons.id, current.id), eq(coupons.active, current.active))).returning();
    if (changed[0]) {
      await writeAudit(transaction, {
        organizationId: null, actorUserId: identity.userId, actorType: "platform_admin",
        action: active ? "coupon.activated" : "coupon.deactivated", resourceType: "coupon", resourceId: current.id,
        changes: { code: current.code, active },
      }, now);
    }
    return changed[0] ?? current;
  });
  return view(updated, usage);
}
