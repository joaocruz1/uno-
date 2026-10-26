import { afterEach, describe, expect, it, vi } from "vitest";

import { checkoutConfigSchema, type CouponPreview, type PaidPlanId } from "@/lib/billing-model";
import { readCheckoutConfig } from "@/server/billing/checkout-config";
import { checkoutPublishableKeyStatus, publishableKeyFix, stripePublishableKey, stripePublishableKeyStatus } from "@/server/billing/config";

// Synthetic values only: never real Stripe keys.
const SECRET_LIVE = "sk_live_SyntheticSecretValue000";
const SECRET_TEST = "sk_test_SyntheticSecretValue000";
const PK_LIVE = "pk_live_SyntheticPublicValue00";
const PK_TEST = "pk_test_SyntheticPublicValue00";
const BILLING = { STRIPE_WEBHOOK_SECRET: "whsec_synthetic", STRIPE_PRICE_STARTER: "price_s", STRIPE_PRICE_PRO: "price_p", STRIPE_PRICE_BUSINESS: "price_b" };

const VARIABLES = ["STRIPE_SECRET_KEY", "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "ADMIN_EMAILS", ...Object.keys(BILLING)] as const;
const saved = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of VARIABLES) {
    if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
  }
  vi.restoreAllMocks();
});

describe("publishable key status (checkout diagnostics)", () => {
  it("reports every reason with modes only", () => {
    expect(stripePublishableKeyStatus({ ...BILLING, STRIPE_SECRET_KEY: SECRET_LIVE, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: PK_LIVE }))
      .toEqual({ key: PK_LIVE, reason: "ok", secretMode: "live", publishableMode: "live" });
    expect(stripePublishableKeyStatus({ ...BILLING, STRIPE_SECRET_KEY: SECRET_LIVE }))
      .toEqual({ key: null, reason: "missing", secretMode: "live", publishableMode: null });
    expect(stripePublishableKeyStatus({ ...BILLING, STRIPE_SECRET_KEY: SECRET_LIVE, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "  " }).reason).toBe("missing");
    // The secret key pasted in the public variable is malformed, not accepted.
    expect(stripePublishableKeyStatus({ ...BILLING, STRIPE_SECRET_KEY: SECRET_LIVE, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: SECRET_LIVE }))
      .toEqual({ key: null, reason: "malformed", secretMode: "live", publishableMode: null });
    expect(stripePublishableKeyStatus({ ...BILLING, STRIPE_SECRET_KEY: SECRET_LIVE, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: PK_TEST }))
      .toEqual({ key: null, reason: "mode_mismatch", secretMode: "live", publishableMode: "test" });
    expect(stripePublishableKeyStatus({ ...BILLING, STRIPE_SECRET_KEY: "rk_test_SyntheticRestricted", NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: PK_TEST }).reason).toBe("ok");
    expect(stripePublishableKeyStatus({ ...BILLING, STRIPE_SECRET_KEY: "weird_SyntheticSecret", NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: PK_TEST }))
      .toMatchObject({ key: null, reason: "mode_mismatch", secretMode: null });
    // Stripe itself not configured comes first: the key alone cannot take a card.
    expect(stripePublishableKeyStatus({ NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: PK_TEST }))
      .toEqual({ key: null, reason: "billing_not_configured", secretMode: null, publishableMode: "test" });
    expect(stripePublishableKeyStatus({ STRIPE_SECRET_KEY: SECRET_LIVE, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: PK_LIVE }).reason).toBe("billing_not_configured");
    // The key-only helper keeps its NEX-52 behaviour.
    expect(stripePublishableKey({ STRIPE_SECRET_KEY: SECRET_TEST, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: PK_TEST })).toBe(PK_TEST);
  });

  it("explains the fix without ever echoing a key value", () => {
    const cases = [
      { ...BILLING, STRIPE_SECRET_KEY: SECRET_LIVE },
      { ...BILLING, STRIPE_SECRET_KEY: SECRET_LIVE, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: SECRET_LIVE },
      { ...BILLING, STRIPE_SECRET_KEY: SECRET_LIVE, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: PK_TEST },
      { NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: PK_TEST },
      { ...BILLING, STRIPE_SECRET_KEY: SECRET_LIVE, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: PK_LIVE },
    ];
    const texts = cases.map((environment) => publishableKeyFix(stripePublishableKeyStatus(environment)));
    expect(texts[0]).toBe("Ausente: defina NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_… no serviço uno e implante de novo.");
    expect(texts[1]).toContain("chave publicável (pk_live_…)");
    expect(texts[2]).toContain("Modo diferente: a secreta é live e a pública é test");
    expect(texts[3]).toContain("Cobrança não configurada");
    expect(texts[4]).toContain("modo live");
    for (const text of texts) {
      for (const secret of [SECRET_LIVE, PK_TEST, PK_LIVE, "whsec_synthetic", "price_p"]) expect(text.includes(secret)).toBe(false);
    }
    expect(publishableKeyFix(stripePublishableKeyStatus({ ...BILLING, STRIPE_SECRET_KEY: SECRET_TEST }))).toContain("pk_test_…");
  });

  it("logs one structured line per process when the key is unusable, without values", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const environment = { ...BILLING, STRIPE_SECRET_KEY: SECRET_LIVE, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: PK_TEST };
    checkoutPublishableKeyStatus(environment);
    checkoutPublishableKeyStatus(environment);
    checkoutPublishableKeyStatus({ ...BILLING, STRIPE_SECRET_KEY: SECRET_LIVE });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toEqual({ event: "billing.config.publishable_key_unusable", reason: "mode_mismatch", secretMode: "live", publishableMode: "test" });
    for (const secret of [SECRET_LIVE, PK_TEST]) expect(line.includes(secret)).toBe(false);
  });

  it("gives the reason only to platform admins and prices every plan from the server", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    Object.assign(process.env, BILLING, { STRIPE_SECRET_KEY: SECRET_LIVE, ADMIN_EMAILS: "admin@example.test" });
    delete process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
    const preview = (planId: PaidPlanId): CouponPreview => ({ valid: true, message: "", code: null, appliedDiscount: "first_month", firstPaymentBrlCents: planId === "PRO" ? 1_599 : 999, recurringBrlCents: 4_900, regularBrlCents: 4_900, discountedMonths: 1, label: null });
    const quote = vi.fn(async (planId: PaidPlanId) => ({ preview: preview(planId) })) as unknown as Parameters<typeof readCheckoutConfig>[1];
    const viewer = { organizationId: "org_synthetic", email: "admin@example.test", platformRole: "ADMIN" as const, emailVerified: true };

    const admin = await readCheckoutConfig(viewer, quote);
    expect(checkoutConfigSchema.safeParse(admin).success).toBe(true);
    expect(admin.publishableKey).toBeNull();
    expect(admin.adminDetail).toContain("Ausente: defina NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_…");
    expect(admin.quotes.PRO.firstPaymentBrlCents).toBe(1_599);

    const customer = await readCheckoutConfig({ ...viewer, email: "loja@example.test", platformRole: "USER" }, quote);
    expect(customer.adminDetail).toBeNull();
    // An unverified e-mail never counts as platform admin.
    expect((await readCheckoutConfig({ ...viewer, emailVerified: false }, quote)).adminDetail).toBeNull();

    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = PK_LIVE;
    const ready = await readCheckoutConfig(viewer, quote);
    expect(ready).toMatchObject({ publishableKey: PK_LIVE, adminDetail: null });
  });
});
