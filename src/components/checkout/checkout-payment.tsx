"use client";

import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe, type Appearance, type Stripe, type StripeElementsOptions, type StripeError } from "@stripe/stripe-js";
import { Check, ChevronDown, Lock, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";

import { Button } from "@/components/ui";
import {
  billingStateSchema,
  paymentSessionSchema,
  subscribeResultSchema,
  type CouponPreview,
  type PaidPlanId,
  type PublicBillingPlan,
  type SavedCard,
  type SubscribeResult,
} from "@/lib/billing-model";
import { addonCheckoutPath, checkoutPath } from "@/lib/checkout-intent";
import { cardLabel, submitLabel } from "@/lib/checkout-labels";
import { formatBrlCents } from "@/lib/plans";

import { ApiError, CouponField, NetworkError, planFeatures, postJson, SessionExpiredError, useCouponCheckout } from "./checkout-summary";
import { EngravedText, engravingSeconds, ScanOverlay, SparkBurst, Spinner, useShake } from "./payment-animations";

export type CheckoutTargetProps =
  | { kind: "plan"; plans: PublicBillingPlan[]; quotes: Record<PaidPlanId, CouponPreview>; initialPlan: PaidPlanId; initialCoupon: string | null }
  | { kind: "addon"; addonName: string; priceBrlCents: number; planName: string };

type Props = {
  target: CheckoutTargetProps;
  email: string;
  organizationName: string;
  canManage: boolean;
  /** Null when Stripe is not configured for this installation: payment is disabled. */
  publishableKey: string | null;
  selfPath: string;
};

/**
 * idle → processing (button busy, scan over the summary) → authenticating (3DS
 * taking a while) → activating (paid, waiting for the webhook) → success (the
 * server says the plan is active). Errors go back to idle with a message.
 */
type Phase = "idle" | "processing" | "authenticating" | "activating" | "success";
type Failure = { kind: "card" | "network" | "expired" | "coupon" | "other"; message: string; action?: { href: string; label: string } };
type SessionState = { status: "loading" } | { status: "ready"; secret: string; cards: SavedCard[] } | { status: "error"; failure: Failure };

/** A failure already mapped to what the buyer reads. */
class CheckoutFailure extends Error {
  constructor(readonly failure: Failure) { super(failure.message); this.name = "CheckoutFailure"; }
}

const POLL_FAST_MS = 2_000;
const POLL_SLOW_MS = 6_000;
const SLOW_NOTICE_MS = 45_000;
const REDIRECT_AFTER_MS = 5_500;

let stripeCache: { key: string; promise: Promise<Stripe | null> } | undefined;
function stripeFor(key: string): Promise<Stripe | null> {
  if (!stripeCache || stripeCache.key !== key) stripeCache = { key, promise: loadStripe(key, { locale: "pt-BR" }) };
  return stripeCache.promise;
}

function loginPath(selfPath: string): string {
  return `/login?${new URLSearchParams({ callbackURL: selfPath }).toString()}`;
}

function failureFrom(cause: unknown, selfPath: string): Failure {
  if (cause instanceof SessionExpiredError) return { kind: "expired", message: "Sua sessão expirou. Entre novamente para continuar; o plano escolhido fica guardado.", action: { href: loginPath(selfPath), label: "Entrar novamente" } };
  if (cause instanceof NetworkError) return { kind: "network", message: cause.message };
  if (cause instanceof ApiError) {
    if (cause.code === "invalid_coupon") return { kind: "coupon", message: cause.message };
    if (cause.code === "subscription_exists" || cause.code === "addon_already_active" || cause.code === "checkout_in_progress" || cause.code === "paid_plan_required") {
      return { kind: "other", message: cause.message, action: { href: "/dashboard/billing", label: "Ir para Assinatura" } };
    }
    if (cause.code === "rate_limit_exceeded") return { kind: "other", message: "Muitas tentativas em pouco tempo. Aguarde um minuto e tente novamente." };
    return { kind: "other", message: cause.message };
  }
  return { kind: "other", message: "Não foi possível concluir o pagamento. Tente novamente." };
}

function stripeFailure(error: StripeError): Failure | "paid" {
  // A second confirmation of a payment that already went through.
  if (error.code === "payment_intent_unexpected_state" && error.payment_intent?.status === "succeeded") return "paid";
  if (error.code === "setup_intent_unexpected_state" && error.setup_intent?.status === "succeeded") return "paid";
  if (error.type === "card_error" || error.type === "validation_error") return { kind: "card", message: error.message ?? "Confira os dados do cartão e tente novamente." };
  if (error.type === "api_connection_error") return { kind: "network", message: "Sem conexão com a Stripe. Verifique sua internet e tente novamente." };
  return { kind: "other", message: error.message ?? "Não foi possível concluir o pagamento. Tente novamente." };
}

/** Light/dark Appearance for the Payment Element, read from the page's CSS tokens and kept in sync with the theme. */
function useStripeAppearance(): Appearance | null {
  const [appearance, setAppearance] = useState<Appearance | null>(null);
  useEffect(() => {
    const read = () => {
      const shell = document.querySelector(".app-shell") ?? document.documentElement;
      const css = getComputedStyle(shell);
      const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
      const dark = document.documentElement.getAttribute("data-theme") === "dark";
      const line = token("--color-line-strong", dark ? "#2a2a30" : "#d9d9df");
      const muted = token("--color-muted", "#6b6b73");
      setAppearance({
        theme: dark ? "night" : "stripe",
        variables: {
          colorPrimary: token("--color-uno-red", "#ef233c"),
          colorBackground: token("--color-surface-2", dark ? "#141417" : "#fafafa"),
          colorText: token("--color-ink", dark ? "#ededf0" : "#0b0b0c"),
          colorTextSecondary: muted,
          colorTextPlaceholder: token("--color-faint", "#9a9aa2"),
          // AA contrast for error text on both themes.
          colorDanger: dark ? "#ff6b7c" : "#c8102e",
          fontFamily: "Inter, system-ui, -apple-system, Segoe UI, sans-serif",
          fontSizeBase: "15px",
          borderRadius: "10px",
          spacingUnit: "4px",
        },
        rules: {
          ".Input": { border: `1px solid ${line}`, boxShadow: "none" },
          ".Input:focus": { borderColor: "rgba(239,35,60,.75)", boxShadow: "0 0 0 3px rgba(239,35,60,.22)" },
          ".Label": { color: muted, fontWeight: "500" },
          ".Tab": { border: `1px solid ${line}`, boxShadow: "none" },
          ".Tab--selected": { borderColor: "#ef233c", boxShadow: "0 0 0 1px #ef233c" },
          ".CheckboxInput--checked": { backgroundColor: "#ef233c", borderColor: "#ef233c" },
        },
      });
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    return () => observer.disconnect();
  }, []);
  return appearance;
}

/** What the order costs, from the server's quote. */
type Price = { first: number; recurring: number; regular: number; discountedMonths: number | null; discountLabel: string | null };

function SummaryLines({ title, subtitle, features, price, extra }: { title: string; subtitle?: string; features: string[]; price: Price; extra?: ReactNode }) {
  const discount = price.regular - price.first;
  const laterLabel = price.discountedMonths && price.discountedMonths > 1 && price.recurring < price.regular ? `Do 2º ao ${price.discountedMonths}º mês` : price.first < price.regular ? "A partir do 2º mês" : "Depois, todo mês";
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
          <dt className="text-[var(--color-muted)]">{laterLabel}</dt>
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

function Notice({ tone = "info", children }: { tone?: "info" | "error"; children: ReactNode }) {
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`rounded-lg border px-3 py-2.5 text-sm ${tone === "error" ? "border-red-500/30 bg-red-500/10 text-[var(--color-ink)]" : "border-[var(--color-line)] bg-[var(--color-surface-2)] text-[var(--color-muted)]"}`}>
      {children}
    </div>
  );
}

function PaymentSkeleton() {
  return (
    <div aria-hidden="true" className="space-y-3">
      <div className="h-4 w-28 animate-pulse rounded bg-[var(--color-line)] motion-reduce:animate-none" />
      <div className="h-11 animate-pulse rounded-lg bg-[var(--color-line)] motion-reduce:animate-none" />
      <div className="grid grid-cols-2 gap-3">
        <div className="h-11 animate-pulse rounded-lg bg-[var(--color-line)] motion-reduce:animate-none" />
        <div className="h-11 animate-pulse rounded-lg bg-[var(--color-line)] motion-reduce:animate-none" />
      </div>
    </div>
  );
}

type PaymentFormProps = {
  mode: "subscription" | "setup";
  phase: Phase;
  disabled: boolean;
  label: string;
  cards: SavedCard[];
  onSavedCard(card: SavedCard | null): void;
  requestSubscription(): Promise<SubscribeResult>;
  onStart(): void;
  onAuthenticating(): void;
  onPaid(): void;
  onFail(failure: Failure): void;
  onAmountMismatch(result: SubscribeResult): void;
  children?: ReactNode;
};

/** The Payment Element and the submit button; lives inside <Elements>. */
function PaymentForm({ mode, phase, disabled, label, cards, onSavedCard, requestSubscription, onStart, onAuthenticating, onPaid, onFail, onAmountMismatch, children }: PaymentFormProps) {
  const stripe = useStripe();
  const elements = useElements();
  const [ready, setReady] = useState(false);
  const lock = useRef(false);
  const busy = phase !== "idle";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!stripe || !elements || lock.current || disabled || busy) return;
    lock.current = true;
    onStart();
    try {
      // Field validation first; no request leaves the page with a half-typed card.
      const checked = await elements.submit();
      if (checked.error) {
        onFail({ kind: "card", message: checked.error.message ?? "Confira os dados do cartão." });
        return;
      }
      const result = await requestSubscription();
      if (result.confirmation !== "none" && result.confirmation !== (mode === "subscription" ? "payment" : "setup")) {
        onAmountMismatch(result);
        return;
      }
      if (result.confirmation !== "none" && result.clientSecret) {
        // 3D Secure opens Stripe's challenge on this page; past a moment we say so.
        const timer = window.setTimeout(onAuthenticating, 2_000);
        const returnUrl = `${window.location.origin}/dashboard/billing?checkout=success`;
        let failure: StripeError | undefined;
        let status: string | undefined;
        try {
          if (result.confirmation === "payment") {
            const outcome = await stripe.confirmPayment({ elements, clientSecret: result.clientSecret, confirmParams: { return_url: returnUrl }, redirect: "if_required" });
            failure = outcome.error;
            status = outcome.paymentIntent?.status;
          } else {
            const outcome = await stripe.confirmSetup({ elements, clientSecret: result.clientSecret, confirmParams: { return_url: returnUrl }, redirect: "if_required" });
            failure = outcome.error;
            status = outcome.setupIntent?.status;
          }
        } finally {
          window.clearTimeout(timer);
        }
        if (failure) {
          const mapped = stripeFailure(failure);
          if (mapped === "paid") { onPaid(); return; }
          onFail(mapped);
          return;
        }
        if (status && status !== "succeeded" && status !== "processing") {
          onFail({ kind: "card", message: "O pagamento não foi concluído. Tente novamente ou use outro cartão." });
          return;
        }
      }
      onPaid();
    } catch (cause) {
      onFail(cause instanceof CheckoutFailure ? cause.failure : failureFrom(cause, ""));
    } finally {
      lock.current = false;
    }
  };

  const buttonText = phase === "processing" ? "Processando pagamento…" : phase === "authenticating" ? "Confirmando com o banco…" : phase === "activating" || phase === "success" ? "Ativando seu plano…" : label;

  return (
    <form onSubmit={(event) => void submit(event)} noValidate>
      <div className="relative min-h-[11rem]">
        {!ready ? <div className="absolute inset-0"><PaymentSkeleton /></div> : null}
        <div className={ready ? "" : "opacity-0"}>
          <PaymentElement
            options={{ layout: "tabs", wallets: { applePay: "never", googlePay: "never" }, readOnly: busy }}
            onReady={() => setReady(true)}
            onChange={(event) => {
              const id = event.value.payment_method?.id;
              onSavedCard(id ? cards.find((card) => card.id === id) ?? null : null);
            }}
          />
        </div>
      </div>
      {children}
      <Button type="submit" size="lg" className="mt-5 w-full" disabled={disabled || busy || !stripe || !ready} aria-busy={busy} data-testid="pay-button">
        {busy ? <Spinner /> : <Lock size={15} aria-hidden="true" />}
        <span>{buttonText}</span>
      </Button>
    </form>
  );
}

function SuccessLabel({ title, onContinue }: { title: string; onContinue: () => void }) {
  return (
    <section aria-labelledby="checkout-success" className="mx-auto flex max-w-md flex-col items-center py-6 text-center">
      <p role="status" className="sr-only">Pagamento confirmado. {title}: assinatura ativa.</p>
      <div className="neon-stage w-full max-w-[18rem] rounded-[28px] p-4">
        <div className="relative mx-auto aspect-[2/3] w-full overflow-hidden rounded-2xl bg-white p-5 text-left text-[#0b0b0c] shadow-[0_20px_50px_-20px_rgba(0,0,0,.6)]">
          <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-[.2em] text-[#6b6b73]">
            <span>UNO</span>
            <span>10 × 15</span>
          </div>
          <div className="mt-4 h-px bg-[#e8e8ec]" />
          <div className="mt-10 space-y-3">
            <h2 id="checkout-success" className="font-heading text-3xl font-extrabold leading-tight">
              <EngravedText>{title}</EngravedText>
            </h2>
            <p className="text-base font-semibold text-[#c8102e]">
              <EngravedText delay={1.1}>Assinatura ativa</EngravedText>
            </p>
          </div>
          <div aria-hidden="true" className="absolute inset-x-5 bottom-5 flex h-10 items-end gap-[3px]">
            {Array.from({ length: 34 }, (_, index) => <span key={index} className="h-full bg-[#0b0b0c]" style={{ width: 1 + ((index * 7) % 3) }} />)}
          </div>
          <SparkBurst play delay={engravingSeconds(2)} />
        </div>
      </div>
      <p className="mt-6 text-[var(--color-muted)]">Tudo pronto. Levando você ao painel…</p>
      <Button size="lg" className="mt-4" onClick={onContinue}>Ir para o painel</Button>
    </section>
  );
}

/**
 * Own checkout page (NEX-52): payment on the left (account, Payment Element,
 * coupon), order summary on the right; a single column with a collapsible
 * summary on phones. Stripe's iframe takes the card (PCI SAQ A); the UNO only
 * sees the outcome. Success is announced only once our server reports the plan
 * (or add-on) active, which happens through the Stripe webhook.
 */
export function CheckoutPayment({ target, email, organizationName, canManage, publishableKey, selfPath }: Props) {
  const router = useRouter();
  const groupId = useId();
  const payable = canManage && Boolean(publishableKey);
  const [phase, setPhase] = useState<Phase>("idle");
  const [failure, setFailure] = useState<Failure>();
  const [slow, setSlow] = useState(false);
  const [session, setSession] = useState<SessionState>({ status: "loading" });
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [savedCard, setSavedCard] = useState<SavedCard | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [serverAmounts, setServerAmounts] = useState<Record<string, number>>({});
  const appearance = useStripeAppearance();
  const [shakeRef, shake] = useShake<HTMLDivElement>();
  const keys = useRef(new Map<string, string>());

  // Plan purchases: plan choice and the coupon (NEX-51 rules, priced by the server).
  const plans = target.kind === "plan" ? target.plans : [];
  const [selected, setSelected] = useState<PaidPlanId>(target.kind === "plan" && target.plans.some((plan) => plan.id === target.initialPlan) ? target.initialPlan : "PRO");
  const plan = plans.find((candidate) => candidate.id === selected) ?? plans[0];
  const expire = useCallback(() => setFailure(failureFrom(new SessionExpiredError(), selfPath)), [selfPath]);
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
  const targetKey = target.kind === "addon" ? "addon:API" : `plan:${selected}:${appliedCode ?? ""}`;

  const basePrice: Price = useMemo(() => {
    if (target.kind === "addon") return { first: target.priceBrlCents, recurring: target.priceBrlCents, regular: target.priceBrlCents, discountedMonths: 0, discountLabel: null };
    const quote = coupon.preview?.valid ? coupon.preview : target.quotes[selected];
    const label = quote.appliedDiscount === "coupon" ? `Cupom ${quote.code ?? ""}`.trim() : quote.appliedDiscount === "first_month" ? "Promoção do 1º mês" : null;
    return { first: quote.firstPaymentBrlCents, recurring: quote.recurringBrlCents, regular: quote.regularBrlCents, discountedMonths: quote.discountedMonths, discountLabel: label };
  }, [coupon.preview, selected, target]);
  // What Stripe actually invoiced, once known, wins over the quote.
  const price: Price = serverAmounts[targetKey] !== undefined ? { ...basePrice, first: serverAmounts[targetKey]! } : basePrice;
  const mode = price.first > 0 ? "subscription" : "setup";

  // The Payment Element session (saved cards and the "save" checkbox).
  useEffect(() => {
    if (!payable) return;
    let cancelled = false;
    void (async () => {
      setSession({ status: "loading" });
      try {
        const parsed = paymentSessionSchema.safeParse(await postJson("/api/dashboard/billing/payment-session", {}));
        if (!parsed.success) throw new Error("invalid");
        if (!cancelled) setSession({ status: "ready", secret: parsed.data.customerSessionClientSecret, cards: parsed.data.cards });
      } catch (cause) {
        if (cancelled) return;
        const mapped = cause instanceof SessionExpiredError || cause instanceof NetworkError || cause instanceof ApiError
          ? failureFrom(cause, selfPath)
          : { kind: "other" as const, message: "Não foi possível carregar o pagamento." };
        setSession({ status: "error", failure: mapped });
      }
    })();
    return () => { cancelled = true; };
  }, [payable, selfPath, sessionAttempt]);

  const requestSubscription = useCallback(async (): Promise<SubscribeResult> => {
    // One key per target, reused on every retry: a double click or a declined
    // card retried later gets the same subscription back.
    const key = keys.current.get(targetKey) ?? crypto.randomUUID();
    keys.current.set(targetKey, key);
    const body = target.kind === "addon" ? { addon: "API" } : appliedCode ? { planId: selected, promotionCode: appliedCode } : { planId: selected };
    let payload: unknown;
    try {
      payload = await postJson("/api/dashboard/billing/subscribe", body, { "idempotency-key": key });
    } catch (cause) {
      throw new CheckoutFailure(failureFrom(cause, currentPath));
    }
    const parsed = subscribeResultSchema.safeParse(payload);
    if (!parsed.success) throw new CheckoutFailure({ kind: "other", message: "Não foi possível iniciar o pagamento. Tente novamente." });
    setServerAmounts((current) => current[targetKey] === parsed.data.amountDueBrlCents ? current : { ...current, [targetKey]: parsed.data.amountDueBrlCents });
    return parsed.data;
  }, [appliedCode, currentPath, selected, target.kind, targetKey]);

  const fail = useCallback((next: Failure) => {
    setPhase("idle");
    if (next.kind === "coupon") coupon.reject(next.message);
    setFailure(next);
    if (next.kind === "card") shake();
  }, [coupon, shake]);

  // After the payment: poll our own billing state until the webhook has applied it.
  useEffect(() => {
    if (phase !== "activating") return;
    let cancelled = false;
    let timer: number | undefined;
    const started = Date.now();
    const slowTimer = window.setTimeout(() => setSlow(true), SLOW_NOTICE_MS);
    const poll = async () => {
      try {
        const response = await fetch("/api/dashboard/billing", { cache: "no-store" });
        if (response.status === 401) { if (!cancelled) { setFailure(failureFrom(new SessionExpiredError(), "/dashboard/billing")); } return; }
        const state = billingStateSchema.safeParse(await response.json());
        if (state.success) {
          const active = target.kind === "addon" ? state.data.apiAddon.active : state.data.effectivePlanId === selected;
          if (active && !cancelled) { setPhase("success"); return; }
        }
      } catch {
        // Offline for a moment: keep trying; the payment itself is already done.
      }
      if (!cancelled) timer = window.setTimeout(() => void poll(), Date.now() - started > 2 * 60_000 ? POLL_SLOW_MS : POLL_FAST_MS);
    };
    void poll();
    return () => { cancelled = true; window.clearTimeout(timer); window.clearTimeout(slowTimer); };
  }, [phase, selected, target.kind]);

  useEffect(() => {
    if (phase !== "success") return;
    const timer = window.setTimeout(() => router.push("/dashboard/billing"), REDIRECT_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [phase, router]);

  const elementsOptions = useMemo<StripeElementsOptions | null>(() => {
    if (session.status !== "ready" || !appearance) return null;
    const common = { currency: "brl", allowedPaymentMethodTypes: ["card"], customerSessionClientSecret: session.secret, appearance, locale: "pt-BR" as const, loader: "auto" as const };
    return mode === "subscription" ? { ...common, mode: "subscription", amount: price.first } : { ...common, mode: "setup" };
  }, [appearance, mode, price.first, session]);

  const titleName = target.kind === "addon" ? `+ ${target.addonName}` : `Plano ${plan?.name ?? ""}`;
  const label = submitLabel({
    target: target.kind === "addon" ? { kind: "addon", addonName: target.addonName } : { kind: "plan", planName: plan?.name ?? "" },
    firstPaymentBrlCents: price.first,
    recurringBrlCents: price.recurring,
    savedCard,
  });
  const busy = phase !== "idle";
  const features = target.kind === "addon"
    ? ["Chaves de API e API pública", "Webhooks assinados para o seu ERP", "Limite de requisições do seu plano"]
    : plan ? planFeatures(plan) : [];
  const summarySubtitle = target.kind === "addon" ? `Adicional sobre o plano ${target.planName}, já ativo` : `Para ${organizationName}`;

  if (phase === "success") {
    return <SuccessLabel title={target.kind === "addon" ? `+ ${target.addonName}` : `Plano ${plan?.name ?? ""}`} onContinue={() => router.push("/dashboard/billing")} />;
  }

  if (target.kind === "plan" && !plan) {
    return <Notice tone="error">Nenhum plano disponível no momento. <Link href="/dashboard" className="font-semibold underline">Ir para o painel</Link></Notice>;
  }

  const summary = <SummaryLines title={titleName} subtitle={summarySubtitle} features={features} price={price} />;
  const activatingNote = phase === "activating" ? (
    <Notice>
      <span className="font-semibold text-[var(--color-ink)]">Pagamento recebido, ativando seu plano…</span>
      {slow ? <> A confirmação da Stripe está demorando mais que o normal. Seu pagamento já foi recebido e o plano será ativado assim que ela chegar; você pode acompanhar em <Link href="/dashboard/billing" className="font-semibold text-uno-red underline-offset-4 hover:underline">Assinatura</Link>.</> : null}
    </Notice>
  ) : null;

  const unavailable = !canManage
    ? <Notice>Só o proprietário ou um administrador de {organizationName} pode contratar. Peça a quem administra a organização.</Notice>
    : !publishableKey
      ? <Notice>A cobrança ainda não está configurada. O pagamento fica disponível assim que a Stripe for configurada nesta instalação.</Notice>
      : null;

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
                      <input type="radio" name={`${groupId}-plan`} value={candidate.id} checked={active} onChange={() => { setSelected(candidate.id as PaidPlanId); setFailure(undefined); void coupon.changePlan(candidate.id as PaidPlanId); }} className="sr-only" />
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
            {unavailable ? (
              <>
                {unavailable}
                <Button type="button" size="lg" className="mt-5 w-full" disabled data-testid="pay-button"><Lock size={15} aria-hidden="true" /><span>{label}</span></Button>
              </>
            ) : session.status === "error" ? (
              <Notice tone="error">
                {session.failure.message}{" "}
                {session.failure.action
                  ? <Link href={session.failure.action.href} className="font-semibold text-uno-red underline-offset-4 hover:underline">{session.failure.action.label}</Link>
                  : <button type="button" className="font-semibold text-uno-red underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-uno-red" onClick={() => setSessionAttempt((value) => value + 1)}>Tentar novamente</button>}
              </Notice>
            ) : !elementsOptions || !publishableKey ? (
              <div aria-busy="true"><p className="sr-only" role="status">Carregando o pagamento…</p><PaymentSkeleton /></div>
            ) : (
              <Elements key={mode} stripe={stripeFor(publishableKey)} options={elementsOptions}>
                <PaymentForm
                  mode={mode}
                  phase={phase}
                  disabled={coupon.applying}
                  label={label}
                  cards={session.status === "ready" ? session.cards : []}
                  onSavedCard={setSavedCard}
                  requestSubscription={requestSubscription}
                  onStart={() => { setFailure(undefined); setSlow(false); setPhase("processing"); }}
                  onAuthenticating={() => setPhase((current) => current === "processing" ? "authenticating" : current)}
                  onPaid={() => setPhase("activating")}
                  onFail={fail}
                  onAmountMismatch={(result) => fail({ kind: "other", message: `O valor de hoje foi atualizado para ${formatBrlCents(result.amountDueBrlCents)}. Confira o resumo e confirme de novo.` })}
                >
                  <div aria-live="assertive" className="mt-4 empty:hidden">
                    {failure ? (
                      <Notice tone="error">
                        {failure.message}{" "}
                        {failure.action ? <Link href={failure.action.href} className="font-semibold text-uno-red underline-offset-4 hover:underline">{failure.action.label}</Link> : failure.kind === "card" ? "Corrija os dados ou use outro cartão." : failure.kind === "network" ? "Toque em pagar para tentar de novo." : null}
                      </Notice>
                    ) : null}
                  </div>
                  <div aria-live="polite" className="mt-4 empty:hidden">{activatingNote}</div>
                </PaymentForm>
              </Elements>
            )}
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
