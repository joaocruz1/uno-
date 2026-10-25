import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@/db/schema";
import { auditLogs, billingCheckoutIntents, coupons, organizations, subscriptions, user, type UnoDatabase } from "@/db";
import { billingCheckoutRequestSchema, couponPreviewRequestSchema } from "@/lib/billing-model";
import { adminCustomers, adminFinance } from "@/server/admin";
import { createAdminCoupon, listAdminCoupons, setAdminCouponActive } from "@/server/admin/coupons";
import { createBillingCheckout, reconcileStripeCustomer } from "@/server/billing";
import type { CheckoutDependencies } from "@/server/billing/checkout";
import { clientAddress, previewCoupon, quoteCheckout } from "@/server/billing/coupons";
import type { BillingProvider, CouponCreateInput, PromotionCodeSnapshot, StripeSubscriptionSnapshot } from "@/server/billing/stripe";

const ADMIN = "00000000-0000-4000-8000-000000000001";
const OWNER = "00000000-0000-4000-8000-000000000002";
const ORG = "00000000-0000-4000-8000-000000000101";
const NOW = new Date("2026-10-07T12:00:00.000Z");
const DAY = 86_400_000;

const pglite = new PGlite();
const database = drizzle(pglite, { schema }) as unknown as UnoDatabase;

/** Stripe stand-in: promotion codes, checkout sessions and subscriptions in memory. */
class CouponProvider implements BillingProvider {
  promotions = new Map<string, PromotionCodeSnapshot>();
  checkoutCalls: Array<{ idempotencyKey: string; input: Parameters<BillingProvider["createCheckout"]>[0] }> = [];
  customerCalls: Array<Parameters<BillingProvider["createCustomer"]>[0]> = [];
  expired: string[] = [];
  expireOutcome: "expired" | "complete" = "expired";
  created: CouponCreateInput[] = [];
  activeCalls: Array<{ id: string; active: boolean }> = [];
  subscriptions: StripeSubscriptionSnapshot[] = [];

  async createCustomer(input: Parameters<BillingProvider["createCustomer"]>[0]) { this.customerCalls.push(input); return { id: "cus_coupon" }; }
  async retrievePrice(priceId: string) {
    const prices: Record<string, number> = { price_starter: 1_900, price_pro: 4_900, price_business: 13_900 };
    return { id: priceId, active: true, currency: "brl", unitAmount: prices[priceId] ?? null, recurringInterval: "month", recurringIntervalCount: 1, productId: `prod_${priceId}` };
  }
  async createCheckout(input: Parameters<BillingProvider["createCheckout"]>[0], idempotencyKey: string) {
    this.checkoutCalls.push({ input, idempotencyKey });
    return { id: `cs_${this.checkoutCalls.length}`, url: `https://checkout.stripe.com/c/pay/${this.checkoutCalls.length}`, expiresAt: new Date(NOW.getTime() + 3_600_000) };
  }
  async expireCheckout(sessionId: string) { this.expired.push(sessionId); return this.expireOutcome; }
  async retrievePromotionCode(id: string) { return this.promotions.get(id) ?? null; }
  async createCouponWithCode(input: CouponCreateInput) {
    this.created.push(input);
    const promotionCodeId = `promo_${input.code}`;
    this.promotions.set(promotionCodeId, promotion(promotionCodeId, input.code, { percentOff: input.percentOff, amountOff: input.amountOffBrlCents, duration: input.duration, durationInMonths: input.durationInMonths }));
    return { couponId: `coupon_${input.code}`, promotionCodeId };
  }
  async setPromotionCodeActive(id: string, active: boolean) { this.activeCalls.push({ id, active }); }
  async createPortal() { return { url: "https://billing.stripe.com/p/session/test" }; }
  async listSubscriptions() { return this.subscriptions; }
  async changeSubscriptionPrice() { throw new Error("unused"); }
  async setCancelAtPeriodEnd() { throw new Error("unused"); }
  async cancelSubscriptionNow() { throw new Error("unused"); }
  async listPaidInvoices() { return []; }
  async refundedAmount() { return 0; }
  async createRefund(): Promise<{ id: string }> { throw new Error("unused"); }
  constructEvent(): Stripe.Event { throw new Error("unused"); }
}

function promotion(id: string, code: string, discount: { percentOff: number | null; amountOff: number | null; duration: "once" | "forever" | "repeating"; durationInMonths: number | null }, extra: Partial<PromotionCodeSnapshot> = {}): PromotionCodeSnapshot {
  return {
    id, code, active: true, expiresAt: null, maxRedemptions: null, timesRedeemed: 0, firstTimeTransaction: false,
    coupon: { id: `coupon_${code}`, valid: true, currency: discount.amountOff !== null ? "brl" : null, ...discount },
    ...extra,
  };
}

let provider: CouponProvider;
let sequence = 0;
const deps = (): CheckoutDependencies => ({ database, provider, now: () => NOW, randomId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}` });
const owner = { organizationId: ORG, organizationName: "Loja Cupom", userId: OWNER, membershipRole: "OWNER" as const };

async function insertCoupon(code: string, discount: Parameters<typeof promotion>[2], row: Partial<typeof coupons.$inferInsert> = {}, live: Partial<PromotionCodeSnapshot> = {}) {
  const promotionCodeId = `promo_${code}`;
  provider.promotions.set(promotionCodeId, promotion(promotionCodeId, code, discount, live));
  const [inserted] = await database.insert(coupons).values({
    code, stripeCouponId: `coupon_${code}`, stripePromotionCodeId: promotionCodeId,
    discountType: discount.percentOff !== null ? "PERCENT" : "AMOUNT", percentOff: discount.percentOff, amountOffBrlCents: discount.amountOff,
    duration: discount.duration, durationInMonths: discount.durationInMonths, ...row,
  }).returning();
  return inserted!;
}

const percent = (value: number, duration: "once" | "forever" | "repeating" = "once", months: number | null = null) => ({ percentOff: value, amountOff: null, duration, durationInMonths: months });
const amount = (cents: number, duration: "once" | "forever" | "repeating" = "once", months: number | null = null) => ({ percentOff: null, amountOff: cents, duration, durationInMonths: months });

beforeAll(async () => {
  const directory = fileURLToPath(new URL("../drizzle", import.meta.url));
  for (const name of (await readdir(directory)).filter((file) => /^\d{4}_.*\.sql$/.test(file)).sort()) {
    for (const statement of (await readFile(`${directory}/${name}`, "utf8")).split("--> statement-breakpoint")) if (statement.trim()) await pglite.exec(statement);
  }
  await database.insert(user).values([
    { id: ADMIN, name: "Admin", email: "admin@example.test", emailVerified: true, platformRole: "ADMIN" },
    { id: OWNER, name: "Dona", email: "dona@example.test", emailVerified: false, phone: "+5511987654321" },
  ]);
  await database.insert(organizations).values({ id: ORG, name: "Loja Cupom", slug: "loja-cupom", ownerUserId: OWNER });
});

beforeEach(async () => {
  vi.stubEnv("APP_URL", "http://localhost:3000");
  vi.stubEnv("ADMIN_EMAILS", "admin@example.test");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_synthetic");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_synthetic");
  vi.stubEnv("STRIPE_PRICE_STARTER", "price_starter");
  vi.stubEnv("STRIPE_PRICE_PRO", "price_pro");
  vi.stubEnv("STRIPE_PRICE_BUSINESS", "price_business");
  vi.stubEnv("STRIPE_PRICE_API_ADDON", "");
  // First-month promo coupons (Pro: R$ 15,99 instead of R$ 49,00).
  vi.stubEnv("STRIPE_COUPON_STARTER", "coupon_first_starter");
  vi.stubEnv("STRIPE_COUPON_PRO", "coupon_first_pro");
  vi.stubEnv("STRIPE_COUPON_BUSINESS", "coupon_first_business");
  provider = new CouponProvider();
  await database.delete(auditLogs);
  await database.delete(billingCheckoutIntents);
  await database.delete(subscriptions);
  await database.delete(coupons);
  await database.insert(subscriptions).values({ organizationId: ORG, planId: "FREE", status: "ACTIVE" });
});

afterAll(async () => { vi.unstubAllEnvs(); await pglite.close(); });

describe("coupon preview: best of the coupon and the first-month promo", () => {
  it("applies a coupon that makes the first payment lower than the promo", async () => {
    await insertCoupon("METADE", percent(80, "repeating", 3));
    const preview = await previewCoupon("PRO", " metade ", ORG, deps());
    expect(preview).toEqual({
      valid: true, message: "Cupom METADE aplicado.", code: "METADE", appliedDiscount: "coupon",
      firstPaymentBrlCents: 980, recurringBrlCents: 980, regularBrlCents: 4_900, discountedMonths: 3,
      label: "80% de desconto nos 3 primeiros meses",
    });
  });

  it("keeps the first-month promo when it is already better, and says so", async () => {
    await insertCoupon("DEZ", percent(10));
    const preview = await previewCoupon("PRO", "DEZ", ORG, deps());
    expect(preview).toMatchObject({
      valid: true, appliedDiscount: "first_month", firstPaymentBrlCents: 1_599, recurringBrlCents: 4_900,
      message: "Promoção do 1º mês mantida, que já é melhor que o cupom DEZ.",
    });
  });

  it("on a tie, prefers the coupon only if it also discounts later months", async () => {
    // Pro: 4900 − 3301 = 1599, the same first payment as the promo.
    await insertCoupon("EMPATE", amount(3_301, "forever"));
    await insertCoupon("EMPATEUM", amount(3_301, "once"));
    expect(await previewCoupon("PRO", "EMPATE", ORG, deps())).toMatchObject({ appliedDiscount: "coupon", firstPaymentBrlCents: 1_599, recurringBrlCents: 1_599, discountedMonths: null });
    expect(await previewCoupon("PRO", "EMPATEUM", ORG, deps())).toMatchObject({ appliedDiscount: "first_month", firstPaymentBrlCents: 1_599 });
  });

  it("competes with the full price when the plan's promo coupon is not configured", async () => {
    vi.stubEnv("STRIPE_COUPON_PRO", "");
    await insertCoupon("DEZ", percent(10));
    expect(await previewCoupon("PRO", "DEZ", ORG, deps())).toMatchObject({ appliedDiscount: "coupon", firstPaymentBrlCents: 4_410, recurringBrlCents: 4_900 });
  });

  it("rejects unknown, inactive, expired, wrong-plan and exhausted coupons with clear messages", async () => {
    await insertCoupon("INATIVO", percent(50), { active: false });
    await insertCoupon("VENCIDO", percent(50), { expiresAt: new Date(NOW.getTime() - 1) });
    await insertCoupon("VENCIDOSTRIPE", percent(50), {}, { expiresAt: new Date(NOW.getTime() - 1) });
    await insertCoupon("SOSTARTER", percent(90), { planIds: ["STARTER"] });
    await insertCoupon("ESGOTADO", percent(90), { maxRedemptions: 5 }, { maxRedemptions: 5, timesRedeemed: 5 });
    await insertCoupon("DESLIGADO", percent(90), {}, { active: false });
    // Every refusal gets the same answer, so a response never reveals that a code exists;
    // the reason goes to the server log only.
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const cases: Array<[string, string]> = [
      ["NAOEXISTE", "unknown"], ["a b", "malformed"], ["INATIVO", "inactive"], ["DESLIGADO", "provider_invalid"],
      ["VENCIDO", "expired"], ["VENCIDOSTRIPE", "expired"], ["SOSTARTER", "wrong_plan"], ["ESGOTADO", "exhausted"],
    ];
    for (const [code, reason] of cases) {
      const preview = await previewCoupon("PRO", code, ORG, deps());
      expect(preview, code).toMatchObject({ valid: false, message: "Cupom inválido ou indisponível para este plano.", appliedDiscount: "first_month", firstPaymentBrlCents: 1_599 });
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])), code).toMatchObject({ event: "billing.coupon.rejected", reason });
    }
    log.mockRestore();
    expect(await previewCoupon("STARTER", "SOSTARTER", ORG, deps())).toMatchObject({ valid: true, appliedDiscount: "coupon", firstPaymentBrlCents: 190 });
  });

  it("answers without Stripe for unknown codes and refuses known ones while billing is not configured", async () => {
    await insertCoupon("DEZ", percent(10));
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const lookups = vi.spyOn(provider, "retrievePromotionCode");
    expect(await previewCoupon("PRO", "NAOEXISTE", ORG, deps())).toMatchObject({ valid: false, message: "Cupom inválido ou indisponível para este plano." });
    expect(await previewCoupon("PRO", "DEZ", ORG, deps())).toMatchObject({ valid: false, message: "Cupom inválido ou indisponível para este plano." });
    expect(lookups).not.toHaveBeenCalled();
  });

  it("reads the client address for the per-address limit like the rest of the app", () => {
    expect(clientAddress(new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe("203.0.113.7");
    expect(clientAddress(new Headers({ "x-real-ip": "198.51.100.2" }))).toBe("198.51.100.2");
    expect(clientAddress(new Headers())).toBe("unknown");
  });

  it("validates request shapes at the boundary", () => {
    expect(couponPreviewRequestSchema.safeParse({ planId: "PRO", code: "DEZ" }).success).toBe(true);
    expect(couponPreviewRequestSchema.safeParse({ planId: "FREE", code: "DEZ" }).success).toBe(false);
    expect(couponPreviewRequestSchema.safeParse({ planId: "PRO", code: "" }).success).toBe(false);
    expect(billingCheckoutRequestSchema.safeParse({ planId: "PRO", promotionCode: "DEZ" }).success).toBe(true);
    expect(billingCheckoutRequestSchema.safeParse({ addon: "API", promotionCode: "DEZ" }).success).toBe(false);
  });
});

describe("checkout with a coupon", () => {
  it("passes only the winning coupon's Promotion Code to Stripe and records it on the intent", async () => {
    const coupon = await insertCoupon("METADE", percent(80, "repeating", 3));
    const result = await createBillingCheckout(owner, "PRO", "coupon-checkout-key-0001", deps(), { promotionCode: "metade" });
    expect(result.url).toContain("checkout.stripe.com");
    expect(provider.checkoutCalls).toHaveLength(1);
    expect(provider.checkoutCalls[0]?.input).toMatchObject({ promotionCodeId: "promo_METADE", couponId: null, priceId: "price_pro" });
    const [intent] = await database.select().from(billingCheckoutIntents);
    expect(intent).toMatchObject({ promotionCode: "METADE", appliedDiscount: "COUPON", couponId: coupon.id, status: "OPEN" });
    // The buyer's phone reaches the Stripe Customer.
    expect(provider.customerCalls[0]).toMatchObject({ organizationId: ORG, phone: "+5511987654321" });
  });

  it("keeps the first-month coupon when it wins and when no code is typed", async () => {
    await insertCoupon("DEZ", percent(10));
    await createBillingCheckout(owner, "PRO", "coupon-checkout-key-0002", deps(), { promotionCode: "DEZ" });
    expect(provider.checkoutCalls[0]?.input).toMatchObject({ couponId: "coupon_first_pro", promotionCodeId: null });
    expect((await database.select().from(billingCheckoutIntents))[0]).toMatchObject({ promotionCode: "DEZ", appliedDiscount: "FIRST_MONTH", couponId: null });
    await database.delete(billingCheckoutIntents);
    await createBillingCheckout(owner, "STARTER", "coupon-checkout-key-0003", deps());
    expect(provider.checkoutCalls[1]?.input).toMatchObject({ couponId: "coupon_first_starter", promotionCodeId: null });
    expect((await database.select().from(billingCheckoutIntents))[0]).toMatchObject({ promotionCode: null, appliedDiscount: "FIRST_MONTH" });
  });

  it("allows one use per organization: a paid or carried coupon cannot be used again", async () => {
    const coupon = await insertCoupon("METADE", percent(80));
    expect(await previewCoupon("PRO", "METADE", ORG, deps())).toMatchObject({ valid: true, appliedDiscount: "coupon" });
    await database.insert(billingCheckoutIntents).values({
      organizationId: ORG, planId: "PRO", idempotencyKey: "used-coupon-key-0001", requestHash: "b".repeat(64),
      status: "COMPLETED", promotionCode: "METADE", appliedDiscount: "COUPON", couponId: coupon.id,
    });
    expect(await previewCoupon("PRO", "METADE", ORG, deps())).toMatchObject({ valid: false, message: "Este cupom já foi usado nesta conta." });
    await expect(createBillingCheckout(owner, "PRO", "coupon-checkout-key-0009", deps(), { promotionCode: "METADE" }))
      .rejects.toMatchObject({ code: "invalid_coupon", message: "Este cupom já foi usado nesta conta." });
    // A subscription still carrying it counts as a use too.
    await database.delete(billingCheckoutIntents);
    await database.update(subscriptions).set({ appliedCouponId: coupon.id }).where(eq(subscriptions.organizationId, ORG));
    expect(await previewCoupon("PRO", "METADE", ORG, deps())).toMatchObject({ valid: false, message: "Este cupom já foi usado nesta conta." });
    // Another organization is not affected.
    expect(await previewCoupon("PRO", "METADE", "00000000-0000-4000-8000-000000000999", deps())).toMatchObject({ valid: true });
  });

  it("never lets a retry from an old tab expire the newer Checkout", async () => {
    await insertCoupon("METADE", percent(80));
    await createBillingCheckout(owner, "PRO", "coupon-checkout-key-0010", deps());
    await createBillingCheckout(owner, "PRO", "coupon-checkout-key-0011", deps(), { promotionCode: "METADE" });
    expect(provider.expired).toEqual(["cs_1"]);
    // The first tab retries with its own (now superseded) key.
    await expect(createBillingCheckout(owner, "PRO", "coupon-checkout-key-0010", deps())).rejects.toMatchObject({ code: "checkout_in_progress", status: 409 });
    expect(provider.expired).toEqual(["cs_1"]);
    expect(provider.checkoutCalls).toHaveLength(2);
    const open = await database.select().from(billingCheckoutIntents).where(eq(billingCheckoutIntents.status, "OPEN"));
    expect(open.map((intent) => intent.idempotencyKey)).toEqual(["coupon-checkout-key-0011"]);
    // A retry of the open one still gets its URL.
    expect((await createBillingCheckout(owner, "PRO", "coupon-checkout-key-0011", deps(), { promotionCode: "METADE" })).url).toBe("https://checkout.stripe.com/c/pay/2");
  });

  it("refuses an invalid coupon with its message before touching Stripe Checkout", async () => {
    await expect(createBillingCheckout(owner, "PRO", "coupon-checkout-key-0004", deps(), { promotionCode: "NAOEXISTE" }))
      .rejects.toMatchObject({ code: "invalid_coupon", status: 400, message: "Cupom inválido ou indisponível para este plano." });
    expect(provider.checkoutCalls).toHaveLength(0);
    expect(await database.select().from(billingCheckoutIntents)).toHaveLength(0);
  });

  it("replaces an open Checkout when the buyer comes back with a coupon, and never when it was paid", async () => {
    await insertCoupon("METADE", percent(80));
    await createBillingCheckout(owner, "PRO", "coupon-checkout-key-0005", deps());
    await createBillingCheckout(owner, "PRO", "coupon-checkout-key-0006", deps(), { promotionCode: "METADE" });
    expect(provider.expired).toEqual(["cs_1"]);
    expect(provider.checkoutCalls.map((call) => call.input.promotionCodeId ?? null)).toEqual([null, "promo_METADE"]);
    const intents = await database.select().from(billingCheckoutIntents);
    expect(intents.map((intent) => [intent.idempotencyKey, intent.status]).sort()).toEqual([
      ["coupon-checkout-key-0005", "EXPIRED"], ["coupon-checkout-key-0006", "OPEN"],
    ]);
    // Same key again: idempotent, no third session.
    await createBillingCheckout(owner, "PRO", "coupon-checkout-key-0006", deps(), { promotionCode: "METADE" });
    expect(provider.checkoutCalls).toHaveLength(2);
    // The same key with another coupon is a conflict, as with any other parameter.
    await expect(createBillingCheckout(owner, "PRO", "coupon-checkout-key-0006", deps())).rejects.toMatchObject({ code: "idempotency_conflict" });
    provider.expireOutcome = "complete";
    await expect(createBillingCheckout(owner, "STARTER", "coupon-checkout-key-0007", deps())).rejects.toMatchObject({ code: "checkout_in_progress" });
    expect(provider.checkoutCalls).toHaveLength(2);
  });

  it("re-prices on the server instead of trusting the preview", async () => {
    await insertCoupon("METADE", percent(80));
    const quote = await quoteCheckout("PRO", "METADE", ORG, deps());
    expect(quote.promotionCodeId).toBe("promo_METADE");
    provider.promotions.set("promo_METADE", { ...provider.promotions.get("promo_METADE")!, active: false });
    await expect(createBillingCheckout(owner, "PRO", "coupon-checkout-key-0008", deps(), { promotionCode: "METADE" })).rejects.toMatchObject({ code: "invalid_coupon" });
  });
});

describe("admin coupons", () => {
  it("only lets a platform admin create, list and toggle coupons", async () => {
    await expect(createAdminCoupon({ userId: OWNER }, { code: "X10", kind: "percent", percentOff: 10, duration: "once" }, deps())).rejects.toMatchObject({ code: "forbidden" });
    await expect(listAdminCoupons({ userId: OWNER }, database)).rejects.toMatchObject({ code: "forbidden" });
    expect(provider.created).toHaveLength(0);
  });

  it("creates the Stripe coupon and promotion code, records it with an audit entry and toggles it", async () => {
    const created = await createAdminCoupon({ userId: ADMIN }, {
      code: "bemvindo", kind: "amount", amountOffBrlCents: 500, duration: "repeating", durationInMonths: 2,
      planIds: ["PRO", "BUSINESS"], maxRedemptions: 100, expiresAt: new Date(NOW.getTime() + 30 * DAY).toISOString(),
    }, deps());
    expect(created).toMatchObject({ code: "BEMVINDO", label: expect.stringMatching(/^R\$\s5,00 de desconto nos 2 primeiros meses$/), planIds: ["PRO", "BUSINESS"], maxRedemptions: 100, active: true });
    expect(provider.created[0]).toMatchObject({ code: "BEMVINDO", amountOffBrlCents: 500, percentOff: null, duration: "repeating", durationInMonths: 2, maxRedemptions: 100 });
    // Restricted on Stripe too, by the plans' Products.
    expect(provider.created[0]?.productIds).toEqual(["prod_price_pro", "prod_price_business"]);
    const audit = await database.select().from(auditLogs);
    expect(audit).toEqual([expect.objectContaining({ action: "coupon.created", actorType: "platform_admin", resourceType: "coupon", resourceId: created.id })]);
    await expect(createAdminCoupon({ userId: ADMIN }, { code: "BEMVINDO", kind: "percent", percentOff: 10, duration: "once" }, deps())).rejects.toMatchObject({ code: "coupon_exists" });
    await expect(createAdminCoupon({ userId: ADMIN }, { code: "OUTRO", kind: "percent", duration: "once" }, deps())).rejects.toThrow();
    await expect(createAdminCoupon({ userId: ADMIN }, { code: "PASSADO", kind: "percent", percentOff: 10, duration: "once", expiresAt: new Date(NOW.getTime() - DAY).toISOString() }, deps())).rejects.toMatchObject({ code: "invalid_request" });

    // Usable right away in the preview, and on the plans it applies to only.
    expect(await previewCoupon("PRO", "bemvindo", ORG, deps())).toMatchObject({ valid: true });
    expect(await previewCoupon("STARTER", "bemvindo", ORG, deps())).toMatchObject({ valid: false });

    const off = await setAdminCouponActive({ userId: ADMIN }, created.id, false, deps());
    expect(off.active).toBe(false);
    expect(provider.activeCalls).toEqual([{ id: "promo_BEMVINDO", active: false }]);
    expect(await previewCoupon("PRO", "BEMVINDO", ORG, deps())).toMatchObject({ valid: false, message: "Cupom inválido ou indisponível para este plano." });
    // Idempotent: deactivating again calls nothing.
    await setAdminCouponActive({ userId: ADMIN }, created.id, false, deps());
    expect(provider.activeCalls).toHaveLength(1);
    await expect(setAdminCouponActive({ userId: OWNER }, created.id, true, deps())).rejects.toMatchObject({ code: "forbidden" });
    expect((await database.select().from(auditLogs)).map((row) => row.action).sort()).toEqual(["coupon.created", "coupon.deactivated"]);
  });
});

describe("admin coupon creation failures", () => {
  it("creates an unrestricted coupon without products", async () => {
    await createAdminCoupon({ userId: ADMIN }, { code: "TODOS10", kind: "percent", percentOff: 10, duration: "forever" }, deps());
    expect(provider.created[0]?.productIds).toEqual([]);
  });

  it("deactivates the Promotion Code when the local record cannot be written", async () => {
    // Another record already holds the Promotion Code id the fake will return, so the insert fails.
    await database.insert(coupons).values({ code: "OUTRO", stripeCouponId: "coupon_x", stripePromotionCodeId: "promo_ORFAO", discountType: "PERCENT", percentOff: 5, duration: "once" });
    await expect(createAdminCoupon({ userId: ADMIN }, { code: "ORFAO", kind: "percent", percentOff: 10, duration: "once" }, deps())).rejects.toThrow();
    expect(provider.activeCalls).toEqual([{ id: "promo_ORFAO", active: false }]);
    expect(await database.select().from(coupons).where(eq(coupons.code, "ORFAO"))).toHaveLength(0);
    expect(await database.select().from(auditLogs)).toHaveLength(0);
  });
});

describe("coupon recorded on the subscription and in the finance view", () => {
  const snapshot = (overrides: Partial<StripeSubscriptionSnapshot> = {}): StripeSubscriptionSnapshot => ({
    id: "sub_coupon", customerId: "cus_coupon", status: "active", cancelAtPeriodEnd: false, priceIds: ["price_pro"],
    currentPeriodStart: new Date(NOW.getTime() - DAY), currentPeriodEnd: new Date(NOW.getTime() + 29 * DAY), ...overrides,
  });

  it("stores the coupon from the Stripe discount, keeps it after a one-time discount ends and clears it on a new subscription", async () => {
    const coupon = await insertCoupon("METADE", percent(80));
    await database.update(subscriptions).set({ stripeCustomerId: "cus_coupon" }).where(eq(subscriptions.organizationId, ORG));
    const reconcile = () => reconcileStripeCustomer("cus_coupon", { database, provider, now: () => NOW });
    const row = async () => (await database.select().from(subscriptions).where(eq(subscriptions.organizationId, ORG)))[0]!;

    provider.subscriptions = [snapshot({ promotionCodeIds: ["promo_METADE"] })];
    await reconcile();
    expect(await row()).toMatchObject({ planId: "PRO", appliedCouponId: coupon.id, appliedCouponCode: "METADE", appliedPromotionCodeId: "promo_METADE" });

    provider.subscriptions = [snapshot({ promotionCodeIds: [] })];
    await reconcile();
    expect(await row()).toMatchObject({ appliedCouponCode: "METADE" });

    await database.insert(billingCheckoutIntents).values({
      organizationId: ORG, planId: "PRO", idempotencyKey: "finance-coupon-key-01", requestHash: "a".repeat(64),
      status: "COMPLETED", promotionCode: "METADE", appliedDiscount: "COUPON", couponId: coupon.id, updatedAt: NOW,
    });
    const finance = await adminFinance({ userId: ADMIN }, database, NOW);
    expect(finance.coupons).toEqual([{ code: "METADE", active: true, checkoutsCompleted: 1, subscriptions: 1 }]);
    expect(finance.discountedCheckouts30d).toEqual({ coupon: 1, firstMonth: 0, none: 0 });
    expect(finance.recentPaid[0]).toMatchObject({ organizationName: "Loja Cupom", couponCode: "METADE" });
    expect((await listAdminCoupons({ userId: ADMIN }, database))[0]).toMatchObject({ code: "METADE", checkoutsCompleted: 1, subscriptions: 1 });

    provider.subscriptions = [snapshot({ id: "sub_coupon", status: "canceled" }), snapshot({ id: "sub_next", promotionCodeIds: [] })];
    await reconcile();
    expect(await row()).toMatchObject({ stripeSubscriptionId: "sub_next", appliedCouponId: null, appliedCouponCode: null, appliedPromotionCodeId: null });
  });

  it("shows the owner's phone to the platform admin in the customers view", async () => {
    const customers = await adminCustomers({ userId: ADMIN }, database, NOW);
    expect(customers.find((customer) => customer.organizationId === ORG)).toMatchObject({ ownerEmail: "dona@example.test", ownerPhone: "+5511987654321" });
  });
});
