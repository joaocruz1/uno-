"use client";

import { Check, Lock, Tag, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { z } from "zod";

import { Button } from "@/components/ui";
import { couponPreviewSchema, type CouponPreview, type PaidPlanId, type PublicBillingPlan } from "@/lib/billing-model";
import { formatBrlCents } from "@/lib/plans";

const STRIPE_HOSTS = ["checkout.stripe.com", "billing.stripe.com"];
const errorSchema = z.object({ error: z.object({ code: z.string().optional(), message: z.string() }) });

/** Only an https Stripe Checkout or Billing Portal URL is ever followed. */
export function safeStripeRedirect(value: unknown): string | null {
  const parsed = z.object({ url: z.url() }).safeParse(value);
  if (!parsed.success) return null;
  const destination = new URL(parsed.data.url);
  if (destination.protocol !== "https:" || destination.username || destination.password || !STRIPE_HOSTS.includes(destination.hostname)) return null;
  return destination.href;
}

export function hasPromo(plan: PublicBillingPlan): boolean {
  return plan.priceBrlCents > 0 && plan.firstMonthPriceBrlCents < plan.priceBrlCents;
}

export function planFeatures(plan: PublicBillingPlan): string[] {
  return [
    `${plan.monthlyLimit.toLocaleString("pt-BR")} etiquetas por mês`,
    `Lotes de até ${plan.batchLimit} arquivos`,
    `Arquivos de até ${plan.maxFileMB} MB`,
    `Histórico guardado por ${plan.retentionDays} dias`,
  ];
}

/** Thrown when the session ended between steps, so the caller can ask to sign in again. */
export class SessionExpiredError extends Error {
  constructor() { super("Sua sessão expirou. Entre novamente para continuar."); this.name = "SessionExpiredError"; }
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), cache: "no-store" });
  const payload: unknown = await response.json().catch(() => null);
  if (response.status === 401) throw new SessionExpiredError();
  if (!response.ok) {
    const parsed = errorSchema.safeParse(payload);
    throw new Error(parsed.success ? parsed.data.error.message : "Não foi possível concluir. Tente novamente.");
  }
  return payload;
}

/**
 * Coupon preview and payment for one selected plan. Prices shown come from the
 * server (POST billing/coupon/preview) and checkout recomputes them; nothing
 * here decides what is charged.
 */
export function useCouponCheckout(plan: PublicBillingPlan | undefined, onSessionExpired?: (message: string) => void) {
  const [code, setCode] = useState("");
  const [preview, setPreview] = useState<CouponPreview | null>(null);
  const [couponError, setCouponError] = useState<string>();
  const [applying, setApplying] = useState(false);
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string>();
  const keys = useRef(new Map<string, string>());
  const locked = useRef(false);
  const appliedCode = preview?.valid ? preview.code : null;

  const fail = useCallback((cause: unknown, set: (message: string) => void) => {
    if (cause instanceof SessionExpiredError && onSessionExpired) { onSessionExpired(cause.message); return; }
    set(cause instanceof Error ? cause.message : "Não foi possível concluir. Tente novamente.");
  }, [onSessionExpired]);

  const quote = useCallback(async (planId: PaidPlanId, value: string) => {
    setApplying(true);
    setCouponError(undefined);
    try {
      const result = couponPreviewSchema.safeParse(await postJson("/api/dashboard/billing/coupon/preview", { planId, code: value }));
      if (!result.success) throw new Error("Não foi possível validar o cupom.");
      if (result.data.valid) setPreview(result.data);
      else { setPreview(null); setCouponError(result.data.message); }
    } catch (cause) {
      setPreview(null);
      fail(cause, setCouponError);
    } finally {
      setApplying(false);
    }
  }, [fail]);

  const apply = useCallback(async () => {
    if (!plan || applying) return;
    const value = code.trim();
    if (!value) { setCouponError("Digite o código do cupom."); return; }
    await quote(plan.id as PaidPlanId, value);
  }, [applying, code, plan, quote]);

  // A coupon already applied is re-priced when the buyer switches plans.
  const changePlan = useCallback(async (next: PaidPlanId) => {
    if (appliedCode) await quote(next, appliedCode);
  }, [appliedCode, quote]);

  const clear = useCallback(() => { setPreview(null); setCode(""); setCouponError(undefined); }, []);

  const pay = useCallback(async () => {
    if (locked.current || !plan) return;
    locked.current = true;
    setPaying(true);
    setPayError(undefined);
    try {
      // One key per plan and coupon, reused on retries, so a double click never opens two sessions.
      const keyName = `${plan.id}:${appliedCode ?? ""}`;
      const key = keys.current.get(keyName) ?? crypto.randomUUID();
      keys.current.set(keyName, key);
      const body = await postJson("/api/dashboard/billing/checkout", appliedCode ? { planId: plan.id, promotionCode: appliedCode } : { planId: plan.id }, { "idempotency-key": key });
      const destination = safeStripeRedirect(body);
      if (!destination) throw new Error("Não foi possível abrir o pagamento.");
      window.location.assign(destination);
      return; // Keep the button busy while the browser leaves.
    } catch (cause) {
      fail(cause, setPayError);
    }
    locked.current = false;
    setPaying(false);
  }, [appliedCode, fail, plan]);

  return { code, setCode, preview, couponError, applying, apply, clear, changePlan, pay, paying, payError, appliedCode };
}

export type CouponCheckout = ReturnType<typeof useCouponCheckout>;

/** Coupon input with apply/remove and the server's success or error message. */
export function CouponField({ checkout, disabled = false, idPrefix = "coupon" }: { checkout: CouponCheckout; disabled?: boolean; idPrefix?: string }) {
  const { code, setCode, preview, couponError, applying, apply, clear } = checkout;
  const inputId = `${idPrefix}-code`;
  const messageId = `${idPrefix}-message`;
  if (preview?.valid) {
    const won = preview.appliedDiscount === "coupon";
    return (
      <div className="flex items-start justify-between gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] px-3 py-2.5">
        <p role="status" className="flex min-w-0 items-start gap-2 text-sm text-[var(--color-ink)]">
          {won ? <Check size={16} className="mt-0.5 shrink-0 text-[var(--color-ok)]" aria-hidden="true" /> : <Tag size={16} className="mt-0.5 shrink-0 text-[var(--color-muted)]" aria-hidden="true" />}
          <span className="min-w-0">
            <span className="block">{preview.message}</span>
            {won && preview.label ? <span className="block text-xs text-[var(--color-muted)]">{preview.label}</span> : null}
          </span>
        </p>
        <button type="button" onClick={clear} disabled={disabled} className="shrink-0 rounded-full p-1 text-[var(--color-muted)] hover:bg-[var(--hover-ink)] hover:text-[var(--color-ink)] focus-visible:outline-2 focus-visible:outline-uno-red" aria-label={`Remover o cupom ${preview.code ?? ""}`}><X size={15} /></button>
      </div>
    );
  }
  return (
    <div>
      <label htmlFor={inputId} className="text-sm font-medium text-[var(--color-muted)]">Cupom de desconto</label>
      <div className="mt-2 flex gap-2">
        <input
          id={inputId}
          value={code}
          onChange={(event) => setCode(event.target.value.toUpperCase())}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void apply(); } }}
          disabled={disabled || applying}
          autoComplete="off"
          spellCheck={false}
          maxLength={40}
          placeholder="Código"
          aria-invalid={couponError ? true : undefined}
          aria-describedby={couponError ? messageId : undefined}
          className="h-11 min-w-0 flex-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] px-3 font-mono text-base uppercase text-[var(--color-ink)] outline-none placeholder:font-sans placeholder:normal-case placeholder:text-[var(--color-faint)] focus:border-uno-red/70 focus:ring-2 focus:ring-uno-red/20 disabled:opacity-60 sm:text-sm"
        />
        <Button variant="secondary" className="h-11 shrink-0 rounded-lg" disabled={disabled || applying || !code.trim()} aria-busy={applying} onClick={() => void apply()}>{applying ? "Aplicando…" : "Aplicar"}</Button>
      </div>
      {couponError ? <p id={messageId} role="alert" className="mt-2 text-sm text-uno-red">{couponError}</p> : null}
    </div>
  );
}

/** Today's charge and what follows, from the server's preview when a coupon is applied. */
export function PriceBreakdown({ plan, preview }: { plan: PublicBillingPlan; preview: CouponPreview | null }) {
  const promo = hasPromo(plan);
  const coupon = preview?.valid && preview.appliedDiscount === "coupon" ? preview : null;
  const today = coupon ? coupon.firstPaymentBrlCents : promo ? plan.firstMonthPriceBrlCents : plan.priceBrlCents;
  const discountedMonths = coupon?.discountedMonths;
  let laterLabel = promo ? "A partir do 2º mês" : "Renovação mensal";
  let later = plan.priceBrlCents;
  if (coupon) {
    later = coupon.recurringBrlCents;
    laterLabel = discountedMonths === null ? "Demais meses" : discountedMonths && discountedMonths > 1 ? `Do 2º ao ${discountedMonths}º mês` : "A partir do 2º mês";
  }
  return (
    <dl className="space-y-2 text-sm">
      <div className="flex items-baseline justify-between gap-4">
        <dt className="text-[var(--color-muted)]">Hoje</dt>
        <dd className="flex items-baseline gap-2">
          {today < plan.priceBrlCents ? <span className="text-xs tabular-nums text-[var(--color-faint)] line-through">{formatBrlCents(plan.priceBrlCents)}</span> : null}
          <span className="font-heading text-2xl font-extrabold tabular-nums" data-testid="first-payment">{formatBrlCents(today)}</span>
        </dd>
      </div>
      <div className="flex items-baseline justify-between gap-4">
        <dt className="text-[var(--color-muted)]">{laterLabel}</dt>
        <dd className="tabular-nums text-[var(--color-ink)]">{formatBrlCents(later)}/mês</dd>
      </div>
      {coupon && discountedMonths !== null && discountedMonths !== undefined && discountedMonths > 1 ? (
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-[var(--color-muted)]">Depois</dt>
          <dd className="tabular-nums text-[var(--color-ink)]">{formatBrlCents(plan.priceBrlCents)}/mês</dd>
        </div>
      ) : null}
    </dl>
  );
}

export function SecurePaymentNote() {
  return <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-[var(--color-muted)]"><Lock size={12} aria-hidden="true" /> Pagamento seguro pela Stripe. Cancele quando quiser.</p>;
}
