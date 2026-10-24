import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";

import { CheckoutPicker } from "@/components/checkout/checkout-picker";
import { ThemeToggle } from "@/components/theme-toggle";
import { checkoutPath, parsePlanParam } from "@/lib/checkout-intent";
import { AppError } from "@/lib/errors";
import { readBillingState } from "@/server/billing";
import { billingProviderConfigured, PAID_PLAN_IDS } from "@/server/billing/config";
import { requireActor } from "@/server/http";

// Authenticated page: never prerender at build time, when no database is available.
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Escolha seu plano", robots: { index: false, follow: false } };

export default async function CheckoutPage({ searchParams }: { searchParams: Promise<{ plan?: string | string[] }> }) {
  const query = await searchParams;
  const plan = parsePlanParam(query.plan);

  let actor;
  try {
    actor = await requireActor();
  } catch (error) {
    if (error instanceof AppError && error.code === "unauthorized") {
      const params = new URLSearchParams({ callbackURL: checkoutPath(plan) });
      if (plan) params.set("plan", plan.toLowerCase());
      redirect(`/login?${params.toString()}`);
    }
    if (error instanceof AppError && error.code === "organization_required") redirect("/organization/new");
    throw error;
  }

  const billing = await readBillingState(actor);
  // Already paying, or a live subscription exists: it is managed on the billing page.
  if (billing.effectivePlanId !== "FREE") redirect("/dashboard/billing");
  const canManage = actor.membershipRole === "OWNER" || actor.membershipRole === "ADMIN";
  const configured = billingProviderConfigured();
  if (canManage && configured && !billing.checkoutAvailable) redirect("/dashboard/billing");

  const paidPlans = billing.plans.filter((candidate) => (PAID_PLAN_IDS as readonly string[]).includes(candidate.id));
  const free = billing.plans.find((candidate) => candidate.id === "FREE");

  return (
    <div className="app-shell min-h-screen bg-[var(--color-canvas)] text-[var(--color-ink)]">
      <div aria-hidden="true" className="pointer-events-none fixed inset-x-0 top-0 h-[28rem] bg-[radial-gradient(ellipse_at_50%_-10%,rgba(239,35,60,.14),transparent_60%)]" />
      <header className="relative mx-auto flex max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
        <Link href="/dashboard" className="flex items-center gap-2 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-uno-red" aria-label="UNO — ir para o painel">
          <Image src="/uno-icon.png" width={28} height={28} alt="" />
          <span className="font-heading text-lg font-extrabold tracking-tight">UNO</span>
        </Link>
        <div className="flex items-center gap-3">
          <span className="hidden max-w-[16rem] truncate text-sm text-[var(--color-muted)] sm:block">{actor.email}</span>
          <ThemeToggle className="grid size-9 place-items-center rounded-lg border border-[var(--color-line)] text-[var(--color-muted)] hover:bg-[var(--hover-ink)]" />
        </div>
      </header>
      <main className="relative mx-auto max-w-6xl px-4 pb-16 pt-4 sm:px-6 sm:pt-8">
        <CheckoutPicker
          plans={paidPlans}
          freeMonthlyLimit={free?.monthlyLimit ?? 0}
          initialPlan={plan ?? "PRO"}
          canManage={canManage}
          configured={configured}
          organizationName={actor.organizationName}
        />
      </main>
    </div>
  );
}
