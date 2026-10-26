"use client";

import { Check, ChevronDown, Lock, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

import type { CouponPreview, PaidPlanId, PublicBillingPlan } from "@/lib/billing-model";
import { addonCheckoutPath, checkoutPath } from "@/lib/checkout-intent";
import { cardLabel } from "@/lib/checkout-labels";
import { formatBrlCents } from "@/lib/plans";

import { CouponField, planFeatures, SessionExpiredError, useCouponCheckout } from "./checkout-summary";
import { ScanOverlay, useShake } from "./payment-animations";
import { failureFrom, laterLabel, Notice, PaymentFields, priceFromQuote, SuccessLabel, usePaymentFlow, type Failure, type PaymentOrder, type Price } from "./payment-flow";

export type CheckoutTargetProps =
  | { kind: "plan"; plans: PublicBillingPlan[]; quotes: Record<PaidPlanId, CouponPreview>; initialPlan: PaidPlanId; initialCoupon: string | null }
  | { kind: "addon"; addonName: string; priceBrlCents: number; planName: string };

type Props = {
  target: CheckoutTargetProps;
  email: string;
  organizationName: string;
  canManage: boolean;
  /** Null when the checkout cannot take a card in this installation: payment is disabled. */
  publishableKey: string | null;
  /** Why the key is unusable and how to fix it; only sent to platform admins. */
  adminDetail?: string | null;
  selfPath: string;
};

export function SummaryLines({ title, subtitle, features, price, extra }: { title: string; subtitle?: string; features: string[]; price: Price; extra?: ReactNode }) {
  const discount = price.regular - price.first;
  return (
    <div>
      <p className="font-heading text-xl font-extrabold">{title}</p>
      {subtitle ? <p className="mt-1 text-sm text-[var(--color-muted)]">{subtitle}</p> : null}
      <ul className="mt-4 space-y-2 text-sm text-[var(--color-muted)]">
        {features.map((item) => <li key={item} className="flex gap-2"><Check size={16} className="mt-0.5 shrink-0 text-uno-red" aria-hidden="true" />{item}</li>)}
      </ul>
      {extra}
      <dl className="mt-5 space-y-2 border-t border-[var(--color-line)] pt-4 text-sm">
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-[var(--color-muted)]">Mensalidade</dt>
          <dd className="tabular-nums">{formatBrlCents(price.regular)}/mês</dd>
        </div>
        {discount > 0 ? (
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-[var(--color-muted)]">{price.discountLabel ?? "Desconto"}</dt>
            <dd className="tabular-nums text-[var(--color-ok)]">− {formatBrlCents(discount)}</dd>
          </div>
        ) : null}
        <div className="flex items-baseline justify-between gap-4 border-t border-[var(--color-line)] pt-3">
          <dt className="font-semibold">Total hoje</dt>
          <dd className="font-heading text-2xl font-extrabold tabular-nums" data-testid="total-today">{formatBrlCents(price.first)}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-[var(--color-muted)]">{laterLabel(price)}</dt>
          <dd className="tabular-nums" data-testid="recurring">{formatBrlCents(price.recurring)}/mês</dd>
        </div>
        {price.recurring < price.regular && price.discountedMonths !== null ? (
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-[var(--color-muted)]">Depois</dt>
            <dd className="tabular-nums">{formatBrlCents(price.regular)}/mês</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}

/**
 * Own checkout page (NEX-52): payment on the left (account, Payment Element,
 * coupon), order summary on the right; a single column with a collapsible
 * summary on phones. Stripe's iframe takes the card (PCI SAQ A); the UNO only
 * sees the outcome. Success is announced only once our server reports the plan
 * (or add-on) active, which happens through the Stripe webhook. The payment
 * itself is the shared core in ./payment-flow, also used by the plans dialog.
 * Kept for direct links, the "+ API" add-on and links opened before the dialog
 * took the card.
 */
export function CheckoutPayment({ target, email, organizationName, canManage, publishableKey, adminDetail = null, selfPath }: Props) {
  const groupId = useId();
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [expired, setExpired] = useState<Failure>();

  // Plan purchases: plan choice and the coupon (NEX-51 rules, priced by the server).
  const plans = target.kind === "plan" ? target.plans : [];
  const [selected, setSelected] = useState<PaidPlanId>(target.kind === "plan" && target.plans.some((plan) => plan.id === target.initialPlan) ? target.initialPlan : "PRO");
  const plan = plans.find((candidate) => candidate.id === selected) ?? plans[0];
  const expire = useCallback(() => setExpired(failureFrom(new SessionExpiredError(), selfPath)), [selfPath]);
  const coupon = useCouponCheckout(plan, expire);
  const appliedCode = target.kind === "plan" ? coupon.appliedCode : null;
  const initialCoupon = target.kind === "plan" ? target.initialCoupon : null;
  const couponApplied = useRef(false);
  const { applyCode } = coupon;
  useEffect(() => {
    if (couponApplied.current || !initialCoupon || !canManage) return;
    couponApplied.current = true;
    void applyCode(initialCoupon);
  }, [applyCode, canManage, initialCoupon]);

  const currentPath = target.kind === "addon" ? addonCheckoutPath() : checkoutPath(selected, { coupon: appliedCode });
  const order: PaymentOrder = target.kind === "addon"
    ? { kind: "addon", addonName: target.addonName }
    : { kind: "plan", planId: selected, planName: plan?.name ?? "", promotionCode: appliedCode };
  const quotedPrice: Price = useMemo(() => {
    if (target.kind === "addon") return { first: target.priceBrlCents, recurring: target.priceBrlCents, regular: target.priceBrlCents, discountedMonths: 0, discountLabel: null };
    return priceFromQuote(coupon.preview?.valid ? coupon.preview : target.quotes[selected]);
  }, [coupon.preview, selected, target]);
  const [shakeRef, shake] = useShake<HTMLDivElement>();
  const flow = usePaymentFlow({ order, quotedPrice, publishableKey, canManage, selfPath: currentPath, onCouponRejected: coupon.reject, onCardRejected: shake });
  const { price, busy, savedCard } = flow;

  const titleName = target.kind === "addon" ? `+ ${target.addonName}` : `Plano ${plan?.name ?? ""}`;
  const features = target.kind === "addon"
    ? ["Chaves de API e API pública", "Webhooks assinados para o seu ERP", "Limite de requisições do seu plano"]
    : plan ? planFeatures(plan) : [];
  const summarySubtitle = target.kind === "addon" ? `Adicional sobre o plano ${target.planName}, já ativo` : `Para ${organizationName}`;

  if (flow.phase === "success") return <SuccessLabel title={titleName} onContinue={flow.goToDashboard} />;

  if (target.kind === "plan" && !plan) {
    return <Notice tone="error">Nenhum plano disponível no momento. <Link href="/dashboard" className="font-semibold underline">Ir para o painel</Link></Notice>;
  }

  const summary = <SummaryLines title={titleName} subtitle={summarySubtitle} features={features} price={price} />;

  return (
    <div>
      <p className="text-sm font-semibold text-uno-red">Pagamento</p>
      <h1 className="mt-1 font-heading text-2xl font-extrabold tracking-tight sm:text-3xl">{target.kind === "addon" ? `Contratar + ${target.addonName}` : "Finalize sua assinatura"}</h1>

      {/* Phones: the summary collapses above the payment. */}
      <div className="relative mt-5 overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[var(--color-surface)] lg:hidden">
        <ScanOverlay active={busy} />
        <button type="button" aria-expanded={summaryOpen} aria-controls={`${groupId}-mobile-summary`} onClick={() => setSummaryOpen((open) => !open)} className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-uno-red">
          <span className="min-w-0">
            <span className="block text-sm font-semibold">{summaryOpen ? "Ocultar resumo" : "Resumo do pedido"}</span>
            <span className="block truncate text-xs text-[var(--color-muted)]">{titleName}</span>
          </span>
          <span className="flex shrink-0 items-center gap-2 font-heading text-lg font-extrabold tabular-nums">
            {formatBrlCents(price.first)}
            <ChevronDown size={18} aria-hidden="true" className={`transition-transform motion-reduce:transition-none ${summaryOpen ? "rotate-180" : ""}`} />
          </span>
        </button>
        <div id={`${groupId}-mobile-summary`} hidden={!summaryOpen} className="border-t border-[var(--color-line)] px-4 py-4">
          {summary}
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:mt-8 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start">
        <div ref={shakeRef} className="card-soft min-w-0 rounded-2xl p-5 sm:p-6">
          <section aria-labelledby={`${groupId}-account`}>
            <h2 id={`${groupId}-account`} className="text-sm font-medium text-[var(--color-muted)]">Conta</h2>
            <p className="mt-1 truncate text-sm"><span className="font-semibold">{email}</span><span className="text-[var(--color-muted)]"> · {organizationName}</span></p>
          </section>

          {target.kind === "plan" ? (
            <fieldset className="mt-5" disabled={busy}>
              <legend className="text-sm font-medium text-[var(--color-muted)]">Plano</legend>
              <div className="mt-2 grid grid-cols-3 gap-2">
                {target.plans.map((candidate) => {
                  const active = candidate.id === selected;
                  const quote = target.quotes[candidate.id as PaidPlanId];
                  return (
                    <label key={candidate.id} className={`relative flex cursor-pointer flex-col rounded-xl border px-3 py-2.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-uno-red ${active ? "border-uno-red bg-uno-red/[.06]" : "border-[var(--color-line)] hover:border-[var(--color-line-strong)]"}`}>
                      <input type="radio" name={`${groupId}-plan`} value={candidate.id} checked={active} onChange={() => { setSelected(candidate.id as PaidPlanId); flow.clearFailure(); void coupon.changePlan(candidate.id as PaidPlanId); }} className="sr-only" />
                      <span className="font-heading text-sm font-bold text-[var(--color-ink)]">{candidate.name}</span>
                      <span className="text-xs tabular-nums text-[var(--color-muted)]">{formatBrlCents(quote?.firstPaymentBrlCents ?? candidate.priceBrlCents)}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          ) : null}

          <section aria-labelledby={`${groupId}-card`} className="mt-6">
            <h2 id={`${groupId}-card`} className="mb-3 text-sm font-medium text-[var(--color-muted)]">Cartão de crédito</h2>
            {expired ? (
              <div className="mb-4">
                <Notice tone="error">{expired.message} {expired.action ? <Link href={expired.action.href} className="font-semibold text-uno-red underline-offset-4 hover:underline">{expired.action.label}</Link> : null}</Notice>
              </div>
            ) : null}
            <PaymentFields flow={flow} organizationName={organizationName} adminDetail={adminDetail} disabled={coupon.applying} />
          </section>

          {target.kind === "plan" ? (
            <div className="mt-6 border-t border-[var(--color-line)] pt-5">
              <CouponField checkout={coupon} disabled={busy || !canManage} idPrefix={`${groupId}-coupon`} />
            </div>
          ) : null}

          <div className="mt-6 space-y-2 text-xs text-[var(--color-muted)]">
            <p className="flex gap-2"><ShieldCheck size={14} className="mt-0.5 shrink-0 text-[var(--color-ok)]" aria-hidden="true" /><span>Pagamento processado pela Stripe. A UNO não vê nem guarda o número do cartão.</span></p>
            <p className="flex gap-2"><Lock size={14} className="mt-0.5 shrink-0" aria-hidden="true" /><span>Cancele quando quiser em Configurações → Assinatura. O cartão fica guardado na Stripe para as renovações; marcando &quot;Salvar&quot;, ele também aparece nas próximas compras. Troque ou remova o cartão quando quiser em Configurações → Assinatura.</span></p>
            {savedCard ? <p>Usando o cartão salvo {cardLabel(savedCard)}.</p> : null}
          </div>
          <p className="mt-5 text-center text-sm">
            <Link href={target.kind === "addon" ? "/dashboard/billing" : "/dashboard"} className="text-[var(--color-muted)] underline-offset-4 hover:text-[var(--color-ink)] hover:underline">{target.kind === "addon" ? "Voltar para Assinatura" : "Continuar no plano grátis"}</Link>
          </p>
        </div>

        <aside aria-label="Resumo do pedido" className="card-soft relative hidden overflow-hidden rounded-2xl p-6 lg:sticky lg:top-6 lg:block">
          <ScanOverlay active={busy} />
          <h2 className="mb-3 text-sm font-semibold text-[var(--color-muted)]">Resumo</h2>
          {summary}
        </aside>
      </div>
    </div>
  );
}
