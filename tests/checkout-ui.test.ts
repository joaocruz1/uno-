import { describe, expect, it } from "vitest";

import { sparkVectors, engravingSeconds } from "@/components/checkout/payment-animations";
import { savedCardSchema, subscribeResultSchema } from "@/lib/billing-model";
import { addonCheckoutPath, checkoutPath, parseAddonParam, parseCouponParam } from "@/lib/checkout-intent";
import { cardExpiry, cardLabel, submitLabel } from "@/lib/checkout-labels";
import { stripePublishableKey } from "@/server/billing/config";

describe("own checkout page helpers (NEX-52)", () => {
  it("labels the submit button with the server's first payment and period", () => {
    const plan = { kind: "plan" as const, planName: "Pro" };
    expect(submitLabel({ target: plan, firstPaymentBrlCents: 1_599, recurringBrlCents: 4_900 })).toBe("Assinar Pro · R$ 15,99 no 1º mês");
    expect(submitLabel({ target: plan, firstPaymentBrlCents: 4_900, recurringBrlCents: 4_900 })).toBe("Assinar Pro · R$ 49,00/mês");
    expect(submitLabel({ target: plan, firstPaymentBrlCents: 0, recurringBrlCents: 4_900 })).toBe("Assinar Pro · grátis no 1º mês");
    expect(submitLabel({ target: { kind: "addon", addonName: "API" }, firstPaymentBrlCents: 5_000, recurringBrlCents: 5_000 })).toBe("Contratar + API · R$ 50,00/mês");
    expect(submitLabel({ target: { kind: "addon", addonName: "API" }, firstPaymentBrlCents: 5_000, recurringBrlCents: 5_000, savedCard: { brand: "visa", last4: "4242" } })).toBe("Pagar com Visa •••• 4242 · R$ 50,00/mês");
  });

  it("shows saved cards by brand, last four digits and expiry only", () => {
    expect(cardLabel({ brand: "mastercard", last4: "4444" })).toBe("Mastercard •••• 4444");
    expect(cardLabel({ brand: "newbrand", last4: "0001" })).toBe("Newbrand •••• 0001");
    expect(cardExpiry({ expMonth: 3, expYear: 2034 })).toBe("03/34");
    expect(savedCardSchema.safeParse({ id: "pm_1", brand: "visa", last4: "4242424242424242", expMonth: 1, expYear: 2030, isDefault: false, inUse: false }).success).toBe(false);
  });

  it("carries plan, coupon and add-on in the checkout URL, validated", () => {
    expect(checkoutPath("PRO", { coupon: "METADE" })).toBe("/checkout?plan=pro&coupon=METADE");
    expect(addonCheckoutPath()).toBe("/checkout?addon=API");
    expect(parseCouponParam(" metade ")).toBe("METADE");
    expect(parseCouponParam("<script>")).toBeUndefined();
    expect(parseAddonParam("api")).toBe("API");
    expect(parseAddonParam("webhooks")).toBeUndefined();
  });

  it("validates the subscribe answer the browser acts on", () => {
    expect(subscribeResultSchema.safeParse({ intentId: "i", confirmation: "payment", clientSecret: "pi_1_secret_x", amountDueBrlCents: 1_599, recurringBrlCents: 4_900 }).success).toBe(true);
    expect(subscribeResultSchema.safeParse({ intentId: "i", confirmation: "redirect", clientSecret: null, amountDueBrlCents: 0, recurringBrlCents: 0 }).success).toBe(false);
  });

  it("accepts a publishable key only when well formed and in the secret key's mode", () => {
    expect(stripePublishableKey({})).toBeNull();
    expect(stripePublishableKey({ NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_SyntheticKey123", STRIPE_SECRET_KEY: "sk_test_x" })).toBe("pk_test_SyntheticKey123");
    expect(stripePublishableKey({ NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_SyntheticKey123", STRIPE_SECRET_KEY: "sk_live_x" })).toBeNull();
    expect(stripePublishableKey({ NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "sk_test_SyntheticKey123" })).toBeNull();
  });

  it("keeps the spark burst deterministic and the engraving timing bounded", () => {
    const sparks = sparkVectors(14);
    expect(sparks).toHaveLength(14);
    expect(sparkVectors(14)).toEqual(sparks);
    expect(sparks.every((spark) => Math.hypot(spark.x, spark.y) <= 110 && spark.size >= 3 && spark.size <= 5)).toBe(true);
    expect(sparkVectors(0)).toEqual([]);
    expect(engravingSeconds(2)).toBeLessThan(3);
  });
});
