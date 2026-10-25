"use client";

import { Check, Lock, ArrowRight } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useRef, useState } from "react";
import { z } from "zod";

import { Button } from "@/components/ui";
import type { PaidPlanId, PublicBillingPlan } from "@/lib/billing-model";
import { formatBrlCents } from "@/lib/plans";

const EASE = [0.22, 1, 0.36, 1] as const;
const STRIPE_HOSTS = ["checkout.stripe.com", "billing.stripe.com"];

/** Only an https Stripe Checkout or Billing Portal URL is ever followed. */
export function safeStripeRedirect(value: unknown): string | null {
  const parsed = z.object({ url: z.url() }).safeParse(value);
  if (!parsed.success) return null;
  const destination = new URL(parsed.data.url);
  if (destination.protocol !== "https:" || destination.username || destination.password || !STRIPE_HOSTS.includes(destination.hostname)) return null;
  return destination.href;
}

function promo(plan: PublicBillingPlan): boolean {
  return plan.priceBrlCents > 0 && plan.firstMonthPriceBrlCents < plan.priceBrlCents;
}

function features(plan: PublicBillingPlan): string[] {
  return [
    `${plan.monthlyLimit.toLocaleString("pt-BR")} etiquetas por mês`,
    `Lotes de até ${plan.batchLimit} arquivos`,
    `Arquivos de até ${plan.maxFileMB} MB`,
    `Histórico guardado por ${plan.retentionDays} dias`,
  ];
}

function Steps({ reduce }: { reduce: boolean | null }) {
  const steps = ["Conta criada", "Plano", "Pagamento"];
  return (
    <ol className="flex items-center gap-2 text-xs font-semibold sm:gap-3" aria-label="Etapas">
      {steps.map((label, index) => {
        const done = index === 0;
        const current = index === 1;
        return (
          <li key={label} className="flex items-center gap-2 sm:gap-3" aria-current={current ? "step" : undefined}>
            <span className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 ${current ? "bg-uno-red text-white" : done ? "bg-[var(--color-ok-surface)] text-[var(--color-ok)]" : "border border-[var(--color-line)] text-[var(--color-muted)]"}`}>
              {done ? (
                <motion.span initial={reduce ? false : { scale: 0 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 420, damping: 18, delay: 0.25 }} className="grid place-items-center">
                  <Check size={13} strokeWidth={3} aria-hidden="true" />
                </motion.span>
              ) : (
                <span aria-hidden="true">{index + 1}</span>
              )}
              {label}
            </span>
            {index < steps.length - 1 ? <span aria-hidden="true" className="h-px w-4 bg-[var(--color-line-strong)] sm:w-8" /> : null}
          </li>
        );
      })}
    </ol>
  );
}

export function CheckoutPicker({
  plans,
  freeMonthlyLimit,
  initialPlan,
  canManage,
  configured,
  organizationName,
}: {
  plans: PublicBillingPlan[];
  freeMonthlyLimit: number;
  initialPlan: PaidPlanId;
  canManage: boolean;
  configured: boolean;
  organizationName: string;
}) {
  const reduce = useReducedMotion();
  const [selected, setSelected] = useState<PaidPlanId>(plans.some((plan) => plan.id === initialPlan) ? initialPlan : (plans[0]?.id as PaidPlanId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const keys = useRef(new Map<string, string>());
  const locked = useRef(false);
  const plan = plans.find((candidate) => candidate.id === selected) ?? plans[0];
  const purchasable = canManage && configured;

  const pay = async () => {
    if (locked.current || !purchasable || !plan) return;
    locked.current = true;
    setBusy(true);
    setError(undefined);
    try {
      // One key per plan, reused on retries, so a double click never opens two sessions.
      const key = keys.current.get(plan.id) ?? crypto.randomUUID();
      keys.current.set(plan.id, key);
      const response = await fetch("/api/dashboard/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({ planId: plan.id }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message = z.object({ error: z.object({ message: z.string() }) }).safeParse(body);
        throw new Error(message.success ? message.data.error.message : "Não foi possível abrir o pagamento.");
      }
      const destination = safeStripeRedirect(body);
      if (!destination) throw new Error("Não foi possível abrir o pagamento.");
      window.location.assign(destination);
      return; // Keep the button busy while the browser leaves.
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível abrir o pagamento.");
    }
    locked.current = false;
    setBusy(false);
  };

  const enter = (delay: number) => reduce
    ? {}
    : { initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.6, ease: EASE, delay } };

  if (!plan) {
    return <p role="alert" className="text-sm text-[var(--color-muted)]">Nenhum plano disponível no momento. <Link href="/dashboard" className="font-semibold text-[var(--color-ink)] underline-offset-4 hover:underline">Ir para o painel</Link></p>;
  }

  return (
    <div>
      <motion.div {...enter(0)}>
        <Steps reduce={reduce} />
        <p className="mt-8 text-sm font-semibold text-uno-red">Último passo</p>
        <h1 className="mt-2 max-w-2xl font-heading text-3xl font-extrabold tracking-tight sm:text-4xl">Escolha o ritmo da sua expedição.</h1>
        <p className="mt-3 max-w-2xl text-[var(--color-muted)]">Sua conta em <strong className="font-semibold text-[var(--color-ink)]">{organizationName}</strong> está pronta. Assine agora e converta mais etiquetas por mês, sem marca d&apos;água e sem cobrança por excedente.</p>
      </motion.div>

      <div className="mt-10 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <motion.fieldset {...enter(0.08)} className="min-w-0">
          <legend className="sr-only">Planos</legend>
          <div className="grid gap-4 md:grid-cols-3">
            {plans.map((candidate, index) => {
              const active = candidate.id === selected;
              const featured = candidate.id === "PRO";
              return (
                <motion.label
                  key={candidate.id}
                  {...(reduce ? {} : { initial: { opacity: 0, y: 18 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.55, ease: EASE, delay: 0.14 + index * 0.07 } })}
                  whileHover={reduce ? undefined : { y: -3 }}
                  className={`card-soft relative flex cursor-pointer flex-col rounded-2xl p-5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-uno-red has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-[var(--color-canvas)] ${active ? "border-uno-red!" : "hover:border-[var(--color-line-strong)]!"}`}
                >
                  {featured ? <span className="absolute -top-2.5 left-5 z-10 rounded-full bg-uno-red px-2.5 py-0.5 text-[11px] font-bold whitespace-nowrap text-white shadow-[0_6px_16px_-8px_rgba(239,35,60,.9)]">Mais escolhido</span> : null}
                  <input type="radio" name="plan" value={candidate.id} checked={active} onChange={() => { setSelected(candidate.id as PaidPlanId); setError(undefined); }} className="sr-only" />
                  {active ? (
                    <motion.span
                      layoutId={reduce ? undefined : "plan-glow"}
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 rounded-2xl bg-[radial-gradient(circle_at_50%_0%,rgba(239,35,60,.12),transparent_70%)] shadow-[0_18px_45px_-28px_rgba(239,35,60,.9)]"
                      transition={{ type: "spring", stiffness: 380, damping: 34 }}
                    />
                  ) : null}
                  <span className="relative flex items-center justify-between gap-3">
                    <span className="font-heading text-lg font-bold">{candidate.name}</span>
                    <span aria-hidden="true" className={`grid size-5 place-items-center rounded-full border transition-colors ${active ? "border-uno-red bg-uno-red text-white" : "border-[var(--color-line-strong)]"}`}>
                      {active ? <Check size={12} strokeWidth={3} /> : null}
                    </span>
                  </span>
                  <span className="relative mt-4 block font-heading text-3xl font-extrabold tabular-nums tracking-tight">{formatBrlCents(promo(candidate) ? candidate.firstMonthPriceBrlCents : candidate.priceBrlCents)}</span>
                  <span className="relative mt-1 block text-xs">
                    {promo(candidate) ? (
                      <><span className="font-semibold text-uno-red">no 1º mês</span><span className="text-[var(--color-faint)]"> · depois {formatBrlCents(candidate.priceBrlCents)}/mês</span></>
                    ) : <span className="text-[var(--color-muted)]">por mês</span>}
                  </span>
                  <span className="relative mt-4 block border-t border-[var(--color-line)] pt-4 text-sm text-[var(--color-muted)]">
                    <b className="font-semibold text-[var(--color-ink)]">{candidate.monthlyLimit.toLocaleString("pt-BR")}</b> etiquetas/mês
                  </span>
                </motion.label>
              );
            })}
          </div>
          <p className="mt-4 text-xs text-[var(--color-muted)]">No plano grátis você continua com {freeMonthlyLimit.toLocaleString("pt-BR")} etiquetas por mês. API e webhooks são o adicional + API, contratado depois em Assinatura.</p>
        </motion.fieldset>

        <motion.aside {...enter(0.2)} aria-labelledby="checkout-summary" className="card-soft rounded-2xl p-6 lg:sticky lg:top-6">
          <h2 id="checkout-summary" className="text-sm font-semibold text-[var(--color-muted)]">Resumo</h2>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={plan.id}
              initial={reduce ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? undefined : { opacity: 0, y: -8 }}
              transition={{ duration: 0.22, ease: EASE }}
              aria-live="polite"
            >
              <p className="mt-3 font-heading text-2xl font-extrabold">Plano {plan.name}</p>
              <ul className="mt-5 space-y-2.5 text-sm text-[var(--color-muted)]">
                {features(plan).map((item) => (
                  <li key={item} className="flex gap-2"><Check size={16} className="mt-0.5 shrink-0 text-uno-red" aria-hidden="true" />{item}</li>
                ))}
              </ul>
              <dl className="mt-6 space-y-2 border-t border-[var(--color-line)] pt-5 text-sm">
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-[var(--color-muted)]">Hoje</dt>
                  <dd className="font-heading text-2xl font-extrabold tabular-nums">{formatBrlCents(promo(plan) ? plan.firstMonthPriceBrlCents : plan.priceBrlCents)}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-[var(--color-muted)]">{promo(plan) ? "A partir do 2º mês" : "Renovação mensal"}</dt>
                  <dd className="tabular-nums text-[var(--color-ink)]">{formatBrlCents(plan.priceBrlCents)}/mês</dd>
                </div>
              </dl>
            </motion.div>
          </AnimatePresence>

          {error ? <p role="alert" className="mt-5 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2.5 text-sm text-[var(--color-ink)]">{error}</p> : null}
          {!canManage ? (
            <p role="status" className="mt-5 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] px-3 py-2.5 text-sm text-[var(--color-muted)]">Só o proprietário ou um administrador de {organizationName} pode contratar um plano. Peça a quem administra a organização.</p>
          ) : !configured ? (
            <p role="status" className="mt-5 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] px-3 py-2.5 text-sm text-[var(--color-muted)]">O pagamento ainda não está disponível. Você pode começar agora no plano grátis.</p>
          ) : null}

          <motion.div className="mt-6" whileTap={reduce || !purchasable ? undefined : { scale: 0.98 }}>
            <Button size="lg" className="w-full" disabled={busy || !purchasable} aria-busy={busy} onClick={() => void pay()}>
              {busy ? "Abrindo o pagamento…" : <>Ir para o pagamento <ArrowRight size={16} aria-hidden="true" /></>}
            </Button>
          </motion.div>
          <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-[var(--color-muted)]"><Lock size={12} aria-hidden="true" /> Pagamento seguro pela Stripe. Cancele quando quiser.</p>
          <p className="mt-5 text-center text-sm">
            <Link href="/dashboard" className="text-[var(--color-muted)] underline-offset-4 hover:text-[var(--color-ink)] hover:underline">Continuar no plano grátis</Link>
          </p>
        </motion.aside>
      </div>
    </div>
  );
}
