import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { CheckoutConfig, CouponPreview, PaidPlanId } from "@/lib/billing-model";

// Stripe is never loaded in tests: Elements and the Payment Element are stand-ins.
vi.mock("@stripe/stripe-js", () => ({ loadStripe: vi.fn(async () => null) }));
vi.mock("@stripe/react-stripe-js", () => ({
  Elements: ({ children }: { children: unknown }) => createElement("div", { "data-stripe-elements": "" }, children as never),
  PaymentElement: () => createElement("div", { "data-stripe-payment-element": "" }),
  useStripe: () => null,
  useElements: () => null,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const { PaymentStep } = await import("@/components/checkout/purchase-dialog");
const { useCouponCheckout } = await import("@/components/checkout/checkout-summary");
const { publicPlans } = await import("@/lib/public-plans");

const quote = (first: number, recurring: number): CouponPreview => ({ valid: true, message: "", code: null, appliedDiscount: first < recurring ? "first_month" : "none", firstPaymentBrlCents: first, recurringBrlCents: recurring, regularBrlCents: recurring, discountedMonths: first < recurring ? 1 : 0, label: null });
const quotes: Record<PaidPlanId, CouponPreview> = { STARTER: quote(999, 1_900), PRO: quote(1_599, 4_900), BUSINESS: quote(2_990, 13_900) };

function render(config: Partial<CheckoutConfig>, canManage = true): string {
  const plan = publicPlans().find((candidate) => candidate.id === "PRO");
  if (!plan) throw new Error("Pro plan missing from the catalog");
  function Harness() {
    const coupon = useCouponCheckout(plan);
    return createElement(PaymentStep, {
      billing: { canManage },
      plan: plan!,
      coupon,
      config: { publishableKey: null, adminDetail: null, quotes, ...config },
      onBack: () => undefined,
      onPhase: () => undefined,
      onSessionExpired: () => undefined,
    });
  }
  return renderToStaticMarkup(createElement(Harness));
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&nbsp;| /g, " ").replace(/\s+/g, " ");

describe("plans dialog payment step (NEX-52, card in the dialog)", () => {
  it("shows the compact summary from the server's quote and the pay button with value and period", () => {
    const html = render({ publishableKey: "pk_test_SyntheticPublicValue00" });
    const plain = text(html);
    expect(plain).toContain("Pro");
    expect(plain).toMatch(/Total hoje R\$ 15,99/);
    expect(plain).toMatch(/A partir do 2º mês R\$ 49,00 \/mês/);
    expect(plain).toContain("Alterar plano ou cupom");
    // Effects do not run on the server: the Payment Element session is still loading.
    expect(plain).toContain("Carregando o pagamento…");
    expect(html).not.toContain("billing-not-configured");
  });

  it("without a usable key shows the generic notice and a disabled pay button", () => {
    const html = render({ publishableKey: null });
    const plain = text(html);
    expect(plain).toContain("A cobrança ainda não está configurada.");
    expect(html).not.toContain("checkout-admin-detail");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="pay-button"|<button[^>]*data-testid="pay-button"[^>]*disabled=""/);
    expect(plain).toContain("Assinar Pro · R$ 15,99 no 1º mês");
  });

  it("appends the precise reason only when the server sent it (platform admins)", () => {
    const html = render({ publishableKey: null, adminDetail: "Ausente: defina NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_… no serviço uno e implante de novo." });
    expect(html).toContain("checkout-admin-detail");
    expect(text(html)).toContain("Para administradores: Ausente: defina NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_…");
  });

  it("tells members that only an owner or admin can buy", () => {
    const plain = text(render({ publishableKey: "pk_test_SyntheticPublicValue00" }, false));
    expect(plain).toContain("Só o proprietário ou um administrador de sua organização pode contratar.");
    expect(plain).not.toContain("Carregando o pagamento…");
  });
});
