import { createHmac, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@/db/schema";
import { billingGrants, organizations, pixCharges, subscriptions, user, type UnoDatabase } from "@/db";
import { applyGrant } from "@/server/billing/grants";
import { MercadoPagoProvider } from "@/server/billing/pix/mercadopago";
import type { PixCharge, PixChargeRequest, PixPayment, PixProvider } from "@/server/billing/pix/provider";
import { confirmPixPayment, createPixPurchase, pixMonthlyAmountBrlCents, reconcilePixPurchase, type PixPurchaseDependencies } from "@/server/billing/pix/purchase";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const DAY = 86_400_000;
const USER = "00000000-0000-4000-8000-000000000001";
const ORG = "00000000-0000-4000-8000-000000000101";

const pglite = new PGlite();
const database = drizzle(pglite, { schema }) as unknown as UnoDatabase;

class FakePixProvider implements PixProvider {
  readonly name = "fake";
  lastRequest?: PixChargeRequest;
  payment: PixPayment = { providerChargeId: "mp-1", status: "pending", amountBrlCents: 0, externalReference: null };
  async createCharge(request: PixChargeRequest): Promise<PixCharge> {
    this.lastRequest = request;
    return { providerChargeId: "mp-1", status: "pending", qrCode: "QR-COPIA-E-COLA", qrCodeBase64: "QkFTRTY0", expiresAt: new Date(NOW.getTime() + 1_800_000) };
  }
  async getPayment(providerChargeId: string): Promise<PixPayment> {
    return { ...this.payment, providerChargeId };
  }
  parseWebhook() { return null; }
}

let provider: FakePixProvider;
function deps(): PixPurchaseDependencies {
  return { database, provider, applyGrant, now: () => NOW, randomId: randomUUID };
}

async function applyMigrations() {
  const directory = fileURLToPath(new URL("../drizzle", import.meta.url));
  const names = (await readdir(directory)).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
  for (const name of names) {
    const migration = await readFile(`${directory}/${name}`, "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await pglite.exec(statement);
    }
  }
}

const actor = { organizationId: ORG, userId: USER, email: "pix@example.test" };

beforeAll(async () => {
  await applyMigrations();
  await database.insert(user).values({ id: USER, name: "Pix", email: "pix@example.test", emailVerified: true });
  await database.insert(organizations).values({ id: ORG, name: "Pix", slug: "pix", ownerUserId: USER });
});

beforeEach(async () => {
  provider = new FakePixProvider();
  await database.delete(billingGrants);
  await database.delete(pixCharges);
  await database.delete(subscriptions);
  await database.insert(subscriptions).values({ organizationId: ORG, planId: "FREE", status: "ACTIVE" });
});

afterAll(async () => { await pglite.close(); });

describe("PIX purchase", () => {
  it("creates a pending charge with the QR and the right amount", async () => {
    const purchase = await createPixPurchase(actor, { planId: "STARTER", period: "monthly", cpf: "39053344705" }, deps());
    expect(purchase.status).toBe("PENDING");
    expect(purchase.amountBrlCents).toBe(1_900);
    expect(purchase.qrCode).toBe("QR-COPIA-E-COLA");
    expect(provider.lastRequest?.externalReference).toBe(purchase.id);
    const row = (await database.select().from(pixCharges).where(eq(pixCharges.id, purchase.id)))[0]!;
    expect(row).toMatchObject({ status: "PENDING", providerChargeId: "mp-1", days: 30 });
  });

  it("grants prepaid days once the payment is approved, idempotently", async () => {
    const purchase = await createPixPurchase(actor, { planId: "STARTER", period: "monthly", cpf: "39053344705" }, deps());
    provider.payment = { providerChargeId: "mp-1", status: "approved", amountBrlCents: 1_900, externalReference: purchase.id };

    await confirmPixPayment("mp-1", deps());
    const sub = (await database.select().from(subscriptions).where(eq(subscriptions.organizationId, ORG)))[0]!;
    expect(sub.prepaidPlanId).toBe("STARTER");
    expect(sub.prepaidPeriodEnd!.getTime()).toBe(NOW.getTime() + 30 * DAY);
    expect((await database.select().from(pixCharges).where(eq(pixCharges.id, purchase.id)))[0]!.status).toBe("APPROVED");

    await confirmPixPayment("mp-1", deps()); // replay
    expect(await database.select().from(billingGrants)).toHaveLength(1);
  });

  it("annual period buys 365 days at 12x the monthly price", async () => {
    const purchase = await createPixPurchase(actor, { planId: "PRO", period: "annual", cpf: "39053344705" }, deps());
    expect(purchase.amountBrlCents).toBe(4_900 * 12);
    provider.payment = { providerChargeId: "mp-1", status: "approved", amountBrlCents: 4_900 * 12, externalReference: purchase.id };
    await confirmPixPayment("mp-1", deps());
    const sub = (await database.select().from(subscriptions).where(eq(subscriptions.organizationId, ORG)))[0]!;
    expect(sub.prepaidPlanId).toBe("PRO");
    expect(sub.prepaidPeriodEnd!.getTime()).toBe(NOW.getTime() + 365 * DAY);
  });

  it("does not grant when the paid amount does not match", async () => {
    const purchase = await createPixPurchase(actor, { planId: "STARTER", period: "monthly", cpf: "39053344705" }, deps());
    provider.payment = { providerChargeId: "mp-1", status: "approved", amountBrlCents: 1, externalReference: purchase.id };
    await confirmPixPayment("mp-1", deps());
    expect((await database.select().from(pixCharges).where(eq(pixCharges.id, purchase.id)))[0]!.status).toBe("FAILED");
    expect((await database.select().from(subscriptions).where(eq(subscriptions.organizationId, ORG)))[0]!.prepaidPlanId).toBeNull();
  });
});

describe("PIX first-month price", () => {
  const original = { ...process.env };
  afterEach(() => {
    for (const name of ["STRIPE_COUPON_STARTER", "STRIPE_COUPON_PRO", "STRIPE_COUPON_BUSINESS"]) {
      if (original[name] === undefined) delete process.env[name]; else process.env[name] = original[name];
    }
  });

  it("charges the first-month price on the first purchase only", async () => {
    process.env.STRIPE_COUPON_PRO = "coupon_synthetic_pro";
    expect(await pixMonthlyAmountBrlCents("PRO", ORG, database)).toBe(1_599);
    const purchase = await createPixPurchase(actor, { planId: "PRO", period: "monthly", cpf: "39053344705" }, deps());
    expect(purchase.amountBrlCents).toBe(1_599);
    provider.payment = { providerChargeId: "mp-1", status: "approved", amountBrlCents: 1_599, externalReference: purchase.id };
    await confirmPixPayment("mp-1", deps());
    // Paid once: the cheap month is not sold again.
    expect(await pixMonthlyAmountBrlCents("PRO", ORG, database)).toBe(4_900);
  });

  it("charges the regular price when the organization already has a Stripe subscription", async () => {
    process.env.STRIPE_COUPON_PRO = "coupon_synthetic_pro";
    await database.update(subscriptions).set({ stripeSubscriptionId: "sub_synthetic" }).where(eq(subscriptions.organizationId, ORG));
    expect(await pixMonthlyAmountBrlCents("PRO", ORG, database)).toBe(4_900);
  });

  it("charges the regular price when the promo coupon is not configured", async () => {
    delete process.env.STRIPE_COUPON_PRO;
    expect(await pixMonthlyAmountBrlCents("PRO", ORG, database)).toBe(4_900);
  });

  it("rejects an invalid CPF before reaching the gateway", async () => {
    await expect(createPixPurchase(actor, { planId: "PRO", period: "monthly", cpf: "11111111111" }, deps())).rejects.toThrow();
    expect(provider.lastRequest).toBeUndefined();
  });
});

describe("PIX status polling reconciles with the gateway", () => {
  it("grants and reports APPROVED from the poll when the webhook never came", async () => {
    const purchase = await createPixPurchase(actor, { planId: "STARTER", period: "monthly", cpf: "39053344705" }, deps());
    provider.payment = { providerChargeId: "mp-1", status: "approved", amountBrlCents: 1_900, externalReference: purchase.id };
    const view = await reconcilePixPurchase(ORG, purchase.id, deps());
    expect(view.status).toBe("APPROVED");
    expect((await database.select().from(subscriptions).where(eq(subscriptions.organizationId, ORG)))[0]!.prepaidPlanId).toBe("STARTER");
  });

  it("keeps PENDING while the gateway still says pending, and survives a gateway error", async () => {
    const purchase = await createPixPurchase(actor, { planId: "STARTER", period: "monthly", cpf: "39053344705" }, deps());
    expect((await reconcilePixPurchase(ORG, purchase.id, deps())).status).toBe("PENDING");
    provider.getPayment = async () => { throw new Error("gateway down"); };
    expect((await reconcilePixPurchase(ORG, purchase.id, deps())).status).toBe("PENDING");
  });

  it("never shows another organization's charge", async () => {
    const purchase = await createPixPurchase(actor, { planId: "STARTER", period: "monthly", cpf: "39053344705" }, deps());
    await expect(reconcilePixPurchase("00000000-0000-4000-8000-0000000009ff", purchase.id, deps())).rejects.toMatchObject({ status: 404 });
  });
});

describe("Mercado Pago webhook signature", () => {
  const SECRET = "whsec-test";
  const mp = new MercadoPagoProvider("token", SECRET);

  function signed(dataId: string, ts: string, requestId: string, secret = SECRET) {
    const v1 = createHmac("sha256", secret).update(`id:${dataId};request-id:${requestId};ts:${ts};`).digest("hex");
    return new Headers({ "x-signature": `ts=${ts},v1=${v1}`, "x-request-id": requestId });
  }

  it("accepts a valid signature and returns the payment id", () => {
    const headers = signed("12345", "1700000000", "req-1");
    expect(mp.parseWebhook(headers, JSON.stringify({ type: "payment", data: { id: "12345" } }))).toEqual({ providerChargeId: "12345" });
  });

  it("rejects a tampered signature", () => {
    const headers = signed("12345", "1700000000", "req-1", "wrong-secret");
    expect(() => mp.parseWebhook(headers, JSON.stringify({ type: "payment", data: { id: "12345" } }))).toThrowError(/[Aa]ssinatura/);
  });

  it("ignores non-payment notifications", () => {
    const headers = signed("12345", "1700000000", "req-1");
    expect(mp.parseWebhook(headers, JSON.stringify({ type: "plan", data: { id: "12345" } }))).toBeNull();
  });
});
