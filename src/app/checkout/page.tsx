import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";

import { CheckoutPayment, type CheckoutTargetProps } from "@/components/checkout/checkout-payment";
import { ThemeToggle } from "@/components/theme-toggle";
import type { CouponPreview, PaidPlanId } from "@/lib/billing-model";
import { addonCheckoutPath, checkoutPath, parseAddonParam, parseCouponParam, parsePlanParam } from "@/lib/checkout-intent";
import { AppError } from "@/lib/errors";
import { readBillingState } from "@/server/billing";
import { billingProviderConfigured, PAID_PLAN_IDS, stripePublishableKey } from "@/server/billing/config";
import { quoteCheckout } from "@/server/billing/coupons";
import { requireActor } from "@/server/http";

// Authenticated page: never prerender at build time, when no database is available.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Pagamento", robots: { index: false, follow: false } };

type Query = { plan?: string | string[]; coupon?: string | string[]; addon?: string | string[] };

/**
 * Own checkout (NEX-52): the card is typed in Stripe's Payment Element on this
 * page (`?plan=pro[&coupon=X]` or `?addon=API`). Prices come from the server's
 * quote; the plan is only activated by the Stripe webhook.
 */
export default async function CheckoutPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  const addon = parseAddonParam(query.addon);
  const plan = parsePlanParam(query.plan);
  const coupon = addon ? undefined : parseCouponParam(query.coupon);
  const self = addon ? addonCheckoutPath() : checkoutPath(plan, { coupon: coupon ?? null });

  let actor;
  try {
    actor = await requireActor();
  } catch (error) {
    if (error instanceof AppError && error.code === "unauthorized") {
      // Signing in again comes back here with the same plan and coupon.
      const params = new URLSearchParams({ callbackURL: self });
      if (plan) params.set("plan", plan.toLowerCase());
      redirect(`/login?${params.toString()}`);
    }
    if (error instanceof AppError && error.code === "organization_required") redirect("/organization/new");
    throw error;
  }

  const billing = await readBillingState(actor);
  const canManage = actor.membershipRole === "OWNER" || actor.membershipRole === "ADMIN";
  const configured = billingProviderConfigured();
  const publishableKey = configured ? stripePublishableKey() : null;

  let target: CheckoutTargetProps;
  if (addon) {
    // The add-on is bought on top of a paid plan in force, once.
    if (billing.effectivePlanId === "FREE" || billing.apiAddon.active) redirect("/dashboard/billing");
    if (canManage && configured && !billing.apiAddon.available) redirect("/dashboard/billing");
    target = {
      kind: "addon",
      addonName: billing.apiAddon.name,
      priceBrlCents: billing.apiAddon.priceBrlCents,
      planName: billing.plans.find((candidate) => candidate.id === billing.effectivePlanId)?.name ?? billing.effectivePlanId,
    };
  } else {
    // Already paying, or a live subscription exists: it is managed on the billing page.
    if (billing.effectivePlanId !== "FREE") redirect("/dashboard/billing");
    if (canManage && configured && !billing.checkoutAvailable) redirect("/dashboard/billing");
    const plans = billing.plans.filter((candidate) => (PAID_PLAN_IDS as readonly string[]).includes(candidate.id));
    // The price without a coupon, as the server will charge it (no Stripe call without a code).
    const quotes = {} as Record<PaidPlanId, CouponPreview>;
    for (const candidate of PAID_PLAN_IDS) quotes[candidate] = (await quoteCheckout(candidate, null, actor.organizationId)).preview;
    target = { kind: "plan", plans, quotes, initialPlan: plan ?? "PRO", initialCoupon: coupon ?? null };
  }

  return (
    <div className="app-shell min-h-screen overflow-x-hidden bg-[var(--color-canvas)] text-[var(--color-ink)]">
      <div aria-hidden="true" className="pointer-events-none fixed inset-x-0 top-0 h-[28rem] bg-[radial-gradient(ellipse_at_50%_-10%,rgba(239,35,60,.12),transparent_60%)]" />
      <header className="relative mx-auto flex max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
        <Link href="/dashboard" className="flex items-center gap-2 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-uno-red" aria-label="UNO — ir para o painel">
          <Image src="/uno-icon.png" width={28} height={28} alt="" />
          <span className="font-heading text-lg font-extrabold tracking-tight">UNO</span>
        </Link>
        <ThemeToggle className="grid size-9 place-items-center rounded-lg border border-[var(--color-line)] text-[var(--color-muted)] hover:bg-[var(--hover-ink)]" />
      </header>
      <main className="relative mx-auto max-w-6xl px-4 pb-16 pt-2 sm:px-6 sm:pt-6">
        <CheckoutPayment
          target={target}
          email={actor.email}
          organizationName={actor.organizationName}
          canManage={canManage}
          publishableKey={publishableKey}
          selfPath={self}
        />
      </main>
    </div>
  );
}
