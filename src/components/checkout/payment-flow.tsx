"use client";

import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe, type Appearance, type Stripe, type StripeElementsOptions, type StripeError } from "@stripe/stripe-js";
import { Lock } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";

import { Button } from "@/components/ui";
import {
  billingStateSchema,
  paymentSessionSchema,
  subscribeResultSchema,
  type CouponPreview,
  type PaidPlanId,
  type SavedCard,
  type SubscribeResult,
} from "@/lib/billing-model";
import { submitLabel } from "@/lib/checkout-labels";
import { formatBrlCents } from "@/lib/plans";

import { ApiError, NetworkError, postJson, SessionExpiredError } from "./checkout-summary";
import { EngravedText, engravingSeconds, SparkBurst, Spinner } from "./payment-animations";

/**
 * The payment core of the own checkout (NEX-52), shared by the /checkout page
 * and the last step of the plans dialog: the Payment Element session (saved
 * cards), the subscribe call with its Idempotency-Key, confirmPayment /
 * confirmSetup with `redirect: "if_required"` (3D Secure on the same page),
 * declines, and the wait for our server to report the plan active. Nothing
 * here decides a price: the order is priced by the server's quote and the
 * subscribe answer, and only the Stripe webhook activates the plan.
 */

/** What is being bought. The plan's coupon is the one the server already accepted in the preview. */
export type PaymentOrder =
  | { kind: "plan"; planId: PaidPlanId; planName: string; promotionCode: string | null }
  | { kind: "addon"; addonName: string };

/**
 * idle → processing (button busy, scan over the summary) → authenticating (3DS
 * taking a while) → activating (paid, waiting for the webhook) → success (the
 * server says the plan is active). Errors go back to idle with a message.
 */
export type Phase = "idle" | "processing" | "authenticating" | "activating" | "success";
export type Failure = { kind: "card" | "network" | "expired" | "coupon" | "other"; message: string; action?: { href: string; label: string } };
type SessionState = { status: "loading" } | { status: "ready"; secret: string; cards: SavedCard[] } | { status: "error"; failure: Failure };

/** What the order costs, from the server's quote. */
export type Price = { first: number; recurring: number; regular: number; discountedMonths: number | null; discountLabel: string | null };

export function priceFromQuote(quote: CouponPreview): Price {
  const label = quote.appliedDiscount === "coupon" ? `Cupom ${quote.code ?? ""}`.trim() : quote.appliedDiscount === "first_month" ? "Promoção do 1º mês" : null;
  return { first: quote.firstPaymentBrlCents, recurring: quote.recurringBrlCents, regular: quote.regularBrlCents, discountedMonths: quote.discountedMonths, discountLabel: label };
}

/** "A partir do 2º mês", "Do 2º ao 3º mês" or "Depois, todo mês". */
export function laterLabel(price: Price): string {
  if (price.discountedMonths && price.discountedMonths > 1 && price.recurring < price.regular) return `Do 2º ao ${price.discountedMonths}º mês`;
  return price.first < price.regular ? "A partir do 2º mês" : "Depois, todo mês";
}

/** A failure already mapped to what the buyer reads. */
class CheckoutFailure extends Error {
  constructor(readonly failure: Failure) { super(failure.message); this.name = "CheckoutFailure"; }
}

const POLL_FAST_MS = 2_000;
const POLL_SLOW_MS = 6_000;
const SLOW_NOTICE_MS = 45_000;
export const REDIRECT_AFTER_MS = 5_500;
export const SUCCESS_PATH = "/dashboard/billing";

let stripeCache: { key: string; promise: Promise<Stripe | null> } | undefined;
function stripeFor(key: string): Promise<Stripe | null> {
  if (!stripeCache || stripeCache.key !== key) stripeCache = { key, promise: loadStripe(key, { locale: "pt-BR" }) };
  return stripeCache.promise;
}

function loginPath(selfPath: string): string {
  return `/login?${new URLSearchParams({ callbackURL: selfPath }).toString()}`;
}

export function failureFrom(cause: unknown, selfPath: string): Failure {
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

/**
 * Light/dark Appearance for the Payment Element, read from the CSS tokens of
 * the `.app-shell` around `anchor` (the page, or the dialog that is portaled
 * outside it) and kept in sync with the theme.
 */
function useStripeAppearance(anchor: RefObject<HTMLElement | null>): Appearance | null {
  const [appearance, setAppearance] = useState<Appearance | null>(null);
  useEffect(() => {
    const read = () => {
      const shell = anchor.current?.closest(".app-shell") ?? document.querySelector(".app-shell") ?? document.documentElement;
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
  }, [anchor]);
  return appearance;
}

type PaymentFlowInput = {
  order: PaymentOrder;
  /** The server's quote for the order (no Stripe amount known yet). */
  quotedPrice: Price;
  /** Null when the server says the checkout cannot take a card here. */
  publishableKey: string | null;
  canManage: boolean;
  /** Where "Entrar novamente" comes back to after the session expired. */
  selfPath: string;
  /** The coupon stopped being valid between the preview and the payment. */
  onCouponRejected(message: string): void;
  /** When set, an expired session is handed to the caller (the dialog signs in again) instead of a link. */
  onSessionExpired?(message: string): void;
  /** A declined or invalid card (the caller shakes the form). */
  onCardRejected?(): void;
};

/** State and actions of one payment; the caller renders the summary and <PaymentFields>. */
export function usePaymentFlow({ order, quotedPrice, publishableKey, canManage, selfPath, onCouponRejected, onSessionExpired, onCardRejected }: PaymentFlowInput) {
  const router = useRouter();
  const payable = canManage && Boolean(publishableKey);
  const [phase, setPhase] = useState<Phase>("idle");
  const [failure, setFailure] = useState<Failure>();
  const [slow, setSlow] = useState(false);
  const [session, setSession] = useState<SessionState>({ status: "loading" });
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [savedCard, setSavedCard] = useState<SavedCard | null>(null);
  const [serverAmounts, setServerAmounts] = useState<Record<string, number>>({});
  const keys = useRef(new Map<string, string>());

  const planId = order.kind === "plan" ? order.planId : null;
  const promotionCode = order.kind === "plan" ? order.promotionCode : null;
  const targetKey = order.kind === "addon" ? "addon:API" : `plan:${planId}:${promotionCode ?? ""}`;
  // What Stripe actually invoiced, once known, wins over the quote.
  const known = serverAmounts[targetKey];
  const price: Price = known !== undefined ? { ...quotedPrice, first: known } : quotedPrice;
  const mode: "subscription" | "setup" = price.first > 0 ? "subscription" : "setup";
  const label = submitLabel({
    target: order.kind === "addon" ? { kind: "addon", addonName: order.addonName } : { kind: "plan", planName: order.planName },
    firstPaymentBrlCents: price.first,
    recurringBrlCents: price.recurring,
    savedCard,
  });

  const report = useCallback((next: Failure): Failure | undefined => {
    if (next.kind === "expired" && onSessionExpired) { onSessionExpired(next.message); return undefined; }
    return next;
  }, [onSessionExpired]);

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
        const shown = report(mapped);
        if (shown) setSession({ status: "error", failure: shown });
      }
    })();
    return () => { cancelled = true; };
  }, [payable, report, selfPath, sessionAttempt]);

  const requestSubscription = useCallback(async (): Promise<SubscribeResult> => {
    // One key per target, reused on every retry: a double click or a declined
    // card retried later gets the same subscription back.
    const key = keys.current.get(targetKey) ?? crypto.randomUUID();
    keys.current.set(targetKey, key);
    const body = order.kind === "addon" ? { addon: "API" } : promotionCode ? { planId, promotionCode } : { planId };
    let payload: unknown;
    try {
      payload = await postJson("/api/dashboard/billing/subscribe", body, { "idempotency-key": key });
    } catch (cause) {
      throw new CheckoutFailure(failureFrom(cause, selfPath));
    }
    const parsed = subscribeResultSchema.safeParse(payload);
    if (!parsed.success) throw new CheckoutFailure({ kind: "other", message: "Não foi possível iniciar o pagamento. Tente novamente." });
    setServerAmounts((current) => current[targetKey] === parsed.data.amountDueBrlCents ? current : { ...current, [targetKey]: parsed.data.amountDueBrlCents });
    return parsed.data;
  }, [order.kind, planId, promotionCode, selfPath, targetKey]);

  const fail = useCallback((next: Failure) => {
    setPhase("idle");
    if (next.kind === "coupon") onCouponRejected(next.message);
    const shown = report(next);
    setFailure(shown);
    if (shown?.kind === "card") onCardRejected?.();
  }, [onCardRejected, onCouponRejected, report]);

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
        if (response.status === 401) {
          // The payment is done; signing in again shows it on the billing page.
          if (!cancelled) setFailure(failureFrom(new SessionExpiredError(), SUCCESS_PATH));
          return;
        }
        const state = billingStateSchema.safeParse(await response.json());
        if (state.success) {
          const active = planId === null ? state.data.apiAddon.active : state.data.effectivePlanId === planId;
          if (active && !cancelled) { setPhase("success"); return; }
        }
      } catch {
        // Offline for a moment: keep trying; the payment itself is already done.
      }
      if (!cancelled) timer = window.setTimeout(() => void poll(), Date.now() - started > 2 * 60_000 ? POLL_SLOW_MS : POLL_FAST_MS);
    };
    void poll();
    return () => { cancelled = true; window.clearTimeout(timer); window.clearTimeout(slowTimer); };
  }, [phase, planId]);

  const goToDashboard = useCallback(() => router.push(SUCCESS_PATH), [router]);

  useEffect(() => {
    if (phase !== "success") return;
    const timer = window.setTimeout(goToDashboard, REDIRECT_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [goToDashboard, phase]);

  return {
    order,
    phase,
    busy: phase !== "idle",
    failure,
    clearFailure: useCallback(() => setFailure(undefined), []),
    slow,
    session,
    retrySession: useCallback(() => setSessionAttempt((value) => value + 1), []),
    price,
    mode,
    label,
    savedCard,
    setSavedCard,
    payable,
    canManage,
    publishableKey,
    requestSubscription,
    fail,
    start: useCallback(() => { setFailure(undefined); setSlow(false); setPhase("processing"); }, []),
    authenticating: useCallback(() => setPhase((current) => current === "processing" ? "authenticating" : current), []),
    paid: useCallback(() => setPhase("activating"), []),
    goToDashboard,
  };
}

export type PaymentFlow = ReturnType<typeof usePaymentFlow>;

export function Notice({ tone = "info", children, testId }: { tone?: "info" | "error"; children: ReactNode; testId?: string }) {
  return (
    <div role={tone === "error" ? "alert" : "status"} data-testid={testId} className={`rounded-lg border px-3 py-2.5 text-sm ${tone === "error" ? "border-red-500/30 bg-red-500/10 text-[var(--color-ink)]" : "border-[var(--color-line)] bg-[var(--color-surface-2)] text-[var(--color-muted)]"}`}>
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
  flow: PaymentFlow;
  disabled: boolean;
  cards: SavedCard[];
  children?: ReactNode;
};

/** The Payment Element and the submit button; lives inside <Elements>. */
function PaymentForm({ flow, disabled, cards, children }: PaymentFormProps) {
  const stripe = useStripe();
  const elements = useElements();
  const [ready, setReady] = useState(false);
  const lock = useRef(false);
  const { phase, busy, mode, label } = flow;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!stripe || !elements || lock.current || disabled || busy) return;
    lock.current = true;
    flow.start();
    try {
      // Field validation first; no request leaves the page with a half-typed card.
      const checked = await elements.submit();
      if (checked.error) {
        flow.fail({ kind: "card", message: checked.error.message ?? "Confira os dados do cartão." });
        return;
      }
      const result = await flow.requestSubscription();
      if (result.confirmation !== "none" && result.confirmation !== (mode === "subscription" ? "payment" : "setup")) {
        flow.fail({ kind: "other", message: `O valor de hoje foi atualizado para ${formatBrlCents(result.amountDueBrlCents)}. Confira o resumo e confirme de novo.` });
        return;
      }
      if (result.confirmation !== "none" && result.clientSecret) {
        // 3D Secure opens Stripe's challenge over this page; past a moment we say so.
        const timer = window.setTimeout(flow.authenticating, 2_000);
        const returnUrl = `${window.location.origin}${SUCCESS_PATH}?checkout=success`;
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
          if (mapped === "paid") { flow.paid(); return; }
          flow.fail(mapped);
          return;
        }
        if (status && status !== "succeeded" && status !== "processing") {
          flow.fail({ kind: "card", message: "O pagamento não foi concluído. Tente novamente ou use outro cartão." });
          return;
        }
      }
      flow.paid();
    } catch (cause) {
      flow.fail(cause instanceof CheckoutFailure ? cause.failure : failureFrom(cause, ""));
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
              flow.setSavedCard(id ? cards.find((card) => card.id === id) ?? null : null);
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

/** Why there is no card form here: not an owner/admin, or the checkout cannot take a card in this installation. */
export function unavailableMessage(flow: Pick<PaymentFlow, "canManage" | "publishableKey">, organizationName: string, adminDetail: string | null): ReactNode {
  if (!flow.canManage) return <Notice>Só o proprietário ou um administrador de {organizationName} pode contratar. Peça a quem administra a organização.</Notice>;
  if (flow.publishableKey) return null;
  return (
    <Notice testId="billing-not-configured">
      A cobrança ainda não está configurada. O pagamento fica disponível assim que a Stripe for configurada nesta instalação.
      {/* Only sent by the server to platform admins: the precise reason and the fix, never a key value. */}
      {adminDetail ? <span className="mt-1.5 block font-medium text-[var(--color-ink)]" data-testid="checkout-admin-detail">Para administradores: {adminDetail}</span> : null}
    </Notice>
  );
}

/**
 * The card part of the checkout: the unavailable notice, the session error,
 * the skeleton, or Stripe's Payment Element with the pay button, the inline
 * failure and the "activating" note.
 */
export function PaymentFields({ flow, organizationName, adminDetail, disabled = false }: { flow: PaymentFlow; organizationName: string; adminDetail: string | null; disabled?: boolean }) {
  const anchor = useRef<HTMLDivElement>(null);
  const appearance = useStripeAppearance(anchor);
  const { session, mode, price, publishableKey, failure, phase, slow } = flow;

  const elementsOptions = useMemo<StripeElementsOptions | null>(() => {
    if (session.status !== "ready" || !appearance) return null;
    const common = { currency: "brl", allowedPaymentMethodTypes: ["card"], customerSessionClientSecret: session.secret, appearance, locale: "pt-BR" as const, loader: "auto" as const };
    return mode === "subscription" ? { ...common, mode: "subscription", amount: price.first } : { ...common, mode: "setup" };
  }, [appearance, mode, price.first, session]);

  const unavailable = unavailableMessage(flow, organizationName, adminDetail);
  const activatingNote = phase === "activating" ? (
    <Notice>
      <span className="font-semibold text-[var(--color-ink)]">Pagamento recebido, ativando seu plano…</span>
      {slow ? <> A confirmação da Stripe está demorando mais que o normal. Seu pagamento já foi recebido e o plano será ativado assim que ela chegar; você pode acompanhar em <Link href={SUCCESS_PATH} className="font-semibold text-uno-red underline-offset-4 hover:underline">Assinatura</Link>.</> : null}
    </Notice>
  ) : null;

  return (
    <div ref={anchor}>
      {unavailable ? (
        <>
          {unavailable}
          <Button type="button" size="lg" className="mt-5 w-full" disabled data-testid="pay-button"><Lock size={15} aria-hidden="true" /><span>{flow.label}</span></Button>
        </>
      ) : session.status === "error" ? (
        <Notice tone="error">
          {session.failure.message}{" "}
          {session.failure.action
            ? <Link href={session.failure.action.href} className="font-semibold text-uno-red underline-offset-4 hover:underline">{session.failure.action.label}</Link>
            : <button type="button" className="font-semibold text-uno-red underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-uno-red" onClick={flow.retrySession}>Tentar novamente</button>}
        </Notice>
      ) : !elementsOptions || !publishableKey ? (
        <div aria-busy="true"><p className="sr-only" role="status">Carregando o pagamento…</p><PaymentSkeleton /></div>
      ) : (
        <Elements key={mode} stripe={stripeFor(publishableKey)} options={elementsOptions}>
          <PaymentForm flow={flow} disabled={disabled} cards={session.status === "ready" ? session.cards : []}>
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
    </div>
  );
}

/** The plan "engraved" on a 10×15 label with sparks, shown only once the server reports it active. */
export function SuccessLabel({ title, onContinue }: { title: string; onContinue: () => void }) {
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
