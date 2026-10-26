"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ArrowLeft, ArrowRight, Check, Lock, ShieldCheck, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { z } from "zod";

import { friendlyAuthError } from "@/components/auth/auth-errors";
import { PhoneInput } from "@/components/auth/phone-input";
import { Button, ButtonLink } from "@/components/ui";
import { authClient } from "@/lib/auth-client";
import { billingStateSchema, checkoutConfigSchema, type BillingView, type CheckoutConfig, type PaidPlanId, type PublicBillingPlan } from "@/lib/billing-model";
import { checkoutPath } from "@/lib/checkout-intent";
import { cardLabel } from "@/lib/checkout-labels";
import { normalizeBrPhone, PHONE_INVALID_MESSAGE, PHONE_REQUIRED_MESSAGE } from "@/lib/phone";
import { formatBrlCents } from "@/lib/plans";

import { CouponField, hasPromo, planFeatures, PriceBreakdown, SecurePaymentNote, useCouponCheckout, type CouponCheckout } from "./checkout-summary";
import { ScanOverlay, useShake } from "./payment-animations";
import { laterLabel, PaymentFields, priceFromQuote, SuccessLabel, usePaymentFlow, type PaymentOrder, type Phase } from "./payment-flow";

const PAID: readonly PaidPlanId[] = ["STARTER", "PRO", "BUSINESS"];
const inputClass = "mt-2 h-11 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] px-3 text-base text-[var(--color-ink)] outline-none transition placeholder:text-[var(--color-faint)] focus:border-uno-red/70 focus:ring-2 focus:ring-uno-red/20 disabled:opacity-60 sm:text-sm";
const labelClass = "block text-sm font-medium text-[var(--color-ink)]";
const errorEnvelope = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

type Step = "loading" | "auth" | "summary" | "payment";
type AuthTab = "register" | "login";

function priceLine(plan: PublicBillingPlan): string {
  return hasPromo(plan)
    ? `${formatBrlCents(plan.firstMonthPriceBrlCents)} no 1º mês, depois ${formatBrlCents(plan.priceBrlCents)}/mês`
    : `${formatBrlCents(plan.priceBrlCents)}/mês`;
}

function Alert({ children, tone = "error" }: { children: ReactNode; tone?: "error" | "info" }) {
  return (
    <p role={tone === "error" ? "alert" : "status"} className={`rounded-lg border px-3 py-2.5 text-sm text-[var(--color-ink)] ${tone === "error" ? "border-red-500/25 bg-red-500/10" : "border-[var(--color-line)] bg-[var(--color-surface-2)]"}`}>
      {children}
    </p>
  );
}

function Steps({ current }: { current: number }) {
  const labels = ["Conta", "Plano e cupom", "Pagamento"];
  return (
    <ol aria-label="Etapas da compra" className="flex flex-wrap items-center gap-2 text-xs font-semibold">
      {labels.map((label, index) => (
        <li key={label} aria-current={index === current ? "step" : undefined} className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 ${index === current ? "bg-uno-red text-white" : index < current ? "bg-[var(--color-ok-surface)] text-[var(--color-ok)]" : "border border-[var(--color-line)] text-[var(--color-muted)]"}`}>
          {index < current ? <Check size={12} strokeWidth={3} aria-hidden="true" /> : <span aria-hidden="true">{index + 1}</span>}
          {label}
        </li>
      ))}
    </ol>
  );
}

/** Sign-up (with the mandatory phone) or sign-in, without leaving the plans page. */
function AuthStep({ plan, notice, onSignedIn }: { plan: PublicBillingPlan; notice?: string; onSignedIn(): void }) {
  const [tab, setTab] = useState<AuthTab>("register");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [existingEmail, setExistingEmail] = useState(false);
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const tabsId = useId();

  const choose = (next: AuthTab) => { setTab(next); setError(undefined); setExistingEmail(false); };

  const register = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const data = new FormData(event.currentTarget);
    const password = String(data.get("password") ?? "");
    const name = String(data.get("name") ?? "").trim();
    setError(undefined); setExistingEmail(false);
    // Validated here so every message shows in the dialog; the server re-validates.
    if (name.length < 2) { setError("Informe seu nome."); return; }
    if (!z.email().safeParse(email.trim()).success) { setError("Informe um e-mail válido."); return; }
    if (password.length < 8) { setError("A senha deve ter pelo menos 8 caracteres."); return; }
    if (password !== String(data.get("confirmation") ?? "")) { setError("As senhas não coincidem."); return; }
    const normalizedPhone = normalizeBrPhone(phone);
    if (!normalizedPhone) { setError(phone.trim() ? PHONE_INVALID_MESSAGE : PHONE_REQUIRED_MESSAGE); return; }
    setPending(true);
    try {
      // No e-mail confirmation in the purchase flow (owner decision): sign-up signs in at once.
      const result = await authClient.signUp.email({ name, email: email.trim(), password, phone: normalizedPhone });
      if (result.error) {
        const code = result.error.code?.toUpperCase();
        setExistingEmail(code === "USER_ALREADY_EXISTS" || code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL");
        setError(friendlyAuthError(result.error.code));
        return;
      }
      onSignedIn();
    } catch {
      setError(friendlyAuthError());
    } finally {
      setPending(false);
    }
  };

  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const data = new FormData(event.currentTarget);
    setError(undefined);
    setPending(true);
    try {
      const result = await authClient.signIn.email({ email: email.trim(), password: String(data.get("password") ?? ""), rememberMe: true });
      if (result.error) { setError(friendlyAuthError(result.error.code)); return; }
      onSignedIn();
    } catch {
      setError(friendlyAuthError());
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-2)] px-4 py-3">
        <p className="text-xs font-semibold text-uno-red">Plano escolhido</p>
        <p className="mt-1 font-heading text-lg font-bold text-[var(--color-ink)]">{plan.name}</p>
        <p className="text-sm text-[var(--color-muted)]">{priceLine(plan)}</p>
      </div>
      {notice ? <Alert tone="info">{notice}</Alert> : null}
      <div role="tablist" aria-label="Acesso" className="grid grid-cols-2 gap-1 rounded-full border border-[var(--color-line)] p-1">
        {([["register", "Criar conta"], ["login", "Já tenho conta"]] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`${tabsId}-${value}`}
            aria-selected={tab === value}
            aria-controls={`${tabsId}-${value}-panel`}
            onClick={() => choose(value)}
            className={`h-9 rounded-full text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-uno-red ${tab === value ? "bg-uno-red text-white" : "text-[var(--color-muted)] hover:text-[var(--color-ink)]"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {error ? (
        <Alert>
          {error}
          {existingEmail ? <> <button type="button" onClick={() => choose("login")} className="font-semibold text-uno-red underline-offset-4 hover:underline">Entrar com este e-mail</button></> : null}
        </Alert>
      ) : null}
      {tab === "register" ? (
        <form id={`${tabsId}-register-panel`} role="tabpanel" aria-labelledby={`${tabsId}-register`} onSubmit={register} className="space-y-4" noValidate>
          <label className={labelClass}>Nome<input name="name" required autoComplete="name" placeholder="Seu nome" disabled={pending} className={inputClass} /></label>
          <label className={labelClass}>E-mail<input name="email" type="email" required autoComplete="email" placeholder="voce@empresa.com" value={email} onChange={(event) => setEmail(event.target.value)} disabled={pending} className={inputClass} /></label>
          <label className={labelClass}>Telefone (com DDD)<PhoneInput name="phone" required value={phone} onValueChange={setPhone} disabled={pending} className={inputClass} /></label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className={labelClass}>Senha<input name="password" type="password" required minLength={8} maxLength={128} autoComplete="new-password" disabled={pending} className={inputClass} /></label>
            <label className={labelClass}>Confirmar senha<input name="confirmation" type="password" required minLength={8} maxLength={128} autoComplete="new-password" disabled={pending} className={inputClass} /></label>
          </div>
          <Button type="submit" size="lg" className="w-full" disabled={pending} aria-busy={pending}>{pending ? "Criando a conta…" : <>Criar conta e continuar <ArrowRight size={16} aria-hidden="true" /></>}</Button>
          <p className="text-center text-xs text-[var(--color-muted)]">Sem confirmação por e-mail: você segue direto para o pagamento.</p>
        </form>
      ) : (
        <form id={`${tabsId}-login-panel`} role="tabpanel" aria-labelledby={`${tabsId}-login`} onSubmit={login} className="space-y-4">
          <label className={labelClass}>E-mail<input name="email" type="email" required autoComplete="email" placeholder="voce@empresa.com" value={email} onChange={(event) => setEmail(event.target.value)} disabled={pending} className={inputClass} /></label>
          <label className={labelClass}>Senha<input name="password" type="password" required autoComplete="current-password" disabled={pending} className={inputClass} /></label>
          <Button type="submit" size="lg" className="w-full" disabled={pending} aria-busy={pending}>{pending ? "Entrando…" : <>Entrar e continuar <ArrowRight size={16} aria-hidden="true" /></>}</Button>
          <p className="text-center text-xs text-[var(--color-muted)]">
            <Link href="/forgot-password" className="underline-offset-4 hover:text-[var(--color-ink)] hover:underline">Esqueci a senha</Link>
            {" · "}
            <Link href={`/login?plan=${plan.id.toLowerCase()}`} className="underline-offset-4 hover:text-[var(--color-ink)] hover:underline">Entrar com o Google</Link>
          </p>
        </form>
      )}
    </div>
  );
}

type PaidPlans = { plans: PublicBillingPlan[]; plan: PublicBillingPlan | undefined };

function paidPlans(billing: BillingView | undefined, selected: PaidPlanId): PaidPlans {
  const plans = (billing?.plans ?? []).filter((candidate) => (PAID as readonly string[]).includes(candidate.id));
  return { plans, plan: plans.find((candidate) => candidate.id === selected) ?? plans[0] };
}

/** Plan, coupon and price breakdown; "Ir para o pagamento" opens the card step in this same dialog. */
function SummaryStep({ billing, plans, plan, coupon, onSelect, onContinue }: {
  billing: BillingView;
  plans: PublicBillingPlan[];
  plan: PublicBillingPlan | undefined;
  coupon: CouponCheckout;
  onSelect(planId: PaidPlanId): void;
  onContinue(): void;
}) {
  const groupId = useId();
  if (!plan) return <Alert>Nenhum plano disponível no momento.</Alert>;

  const currentPlan = billing.plans.find((candidate) => candidate.id === billing.effectivePlanId);
  if (billing.effectivePlanId !== "FREE") {
    return (
      <div className="space-y-4">
        <Alert tone="info">Sua organização já está no plano {currentPlan?.name ?? billing.effectivePlanId}. Troque de plano ou gerencie a cobrança em Assinatura.</Alert>
        <ButtonLink href="/dashboard/billing" size="lg" className="w-full">Ir para Assinatura</ButtonLink>
      </div>
    );
  }
  const manageable = billing.canManage && billing.billingConfigured && !billing.checkoutAvailable;
  // Without Stripe configured the payment step still opens and says so (with the reason for platform admins).
  const canContinue = billing.canManage && !manageable;

  return (
    <div className="space-y-5">
      <fieldset>
        <legend className="text-sm font-medium text-[var(--color-muted)]">Plano</legend>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {plans.map((candidate) => {
            const active = candidate.id === plan.id;
            return (
              <label key={candidate.id} className={`relative flex cursor-pointer flex-col rounded-xl border px-3 py-2.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-uno-red ${active ? "border-uno-red bg-uno-red/[.06]" : "border-[var(--color-line)] hover:border-[var(--color-line-strong)]"}`}>
                <input type="radio" name={`${groupId}-plan`} value={candidate.id} checked={active} onChange={() => onSelect(candidate.id as PaidPlanId)} className="sr-only" />
                <span className="font-heading text-sm font-bold text-[var(--color-ink)]">{candidate.name}</span>
                <span className="text-xs tabular-nums text-[var(--color-muted)]">{formatBrlCents(hasPromo(candidate) ? candidate.firstMonthPriceBrlCents : candidate.priceBrlCents)}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <ul className="space-y-2 text-sm text-[var(--color-muted)]">
        {planFeatures(plan).map((item) => <li key={item} className="flex gap-2"><Check size={16} className="mt-0.5 shrink-0 text-uno-red" aria-hidden="true" />{item}</li>)}
      </ul>
      <CouponField checkout={coupon} idPrefix={`${groupId}-coupon`} />
      <div className="border-t border-[var(--color-line)] pt-4" aria-live="polite">
        <PriceBreakdown plan={plan} preview={coupon.preview} />
      </div>
      {!billing.canManage ? (
        <Alert tone="info">Só o proprietário ou um administrador da organização pode contratar um plano.</Alert>
      ) : manageable ? (
        <Alert tone="info">Sua organização já tem uma assinatura no cartão. <Link href="/dashboard/billing" className="font-semibold text-uno-red underline-offset-4 hover:underline">Gerencie em Assinatura</Link>.</Alert>
      ) : null}
      <div>
        <Button size="lg" className="w-full" disabled={!canContinue || coupon.applying} onClick={onContinue}>
          Ir para o pagamento <ArrowRight size={16} aria-hidden="true" />
        </Button>
        <SecurePaymentNote />
      </div>
      <p className="text-center text-sm">
        <Link href="/dashboard" className="text-[var(--color-muted)] underline-offset-4 hover:text-[var(--color-ink)] hover:underline">Continuar no plano grátis</Link>
      </p>
    </div>
  );
}

/**
 * Step 3: a compact summary (plan, total today, from the 2nd month) over
 * Stripe's Payment Element and the pay button. The payment core is the same as
 * on /checkout (./payment-flow); plan and coupon are changed back in step 2.
 */
export function PaymentStep({ billing, plan, coupon, config, onBack, onPhase, onSessionExpired }: {
  billing: Pick<BillingView, "canManage">;
  plan: PublicBillingPlan;
  coupon: CouponCheckout;
  config: CheckoutConfig;
  onBack(): void;
  onPhase(phase: Phase): void;
  onSessionExpired(message: string): void;
}) {
  const planId = plan.id as PaidPlanId;
  const order: PaymentOrder = { kind: "plan", planId, planName: plan.name, promotionCode: coupon.appliedCode };
  const quotedPrice = useMemo(() => priceFromQuote(coupon.preview?.valid ? coupon.preview : config.quotes[planId]), [config.quotes, coupon.preview, planId]);
  const [shakeRef, shake] = useShake<HTMLDivElement>();
  const flow = usePaymentFlow({
    onCardRejected: shake,
    order,
    quotedPrice,
    publishableKey: config.publishableKey,
    canManage: billing.canManage,
    selfPath: checkoutPath(planId, { coupon: coupon.appliedCode }),
    onCouponRejected: coupon.reject,
    onSessionExpired,
  });
  const { phase, price, busy } = flow;
  useEffect(() => { onPhase(phase); }, [onPhase, phase]);

  if (phase === "success") return <SuccessLabel title={`Plano ${plan.name}`} onContinue={flow.goToDashboard} />;

  const discount = price.regular - price.first;
  return (
    <div ref={shakeRef} className="space-y-5">
      <div className="relative overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-2)] px-4 py-3.5" aria-label="Resumo do pedido" role="group">
        <ScanOverlay active={busy} />
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-uno-red">Plano</p>
            <p className="font-heading text-lg font-bold text-[var(--color-ink)]">{plan.name}</p>
            {discount > 0 && price.discountLabel ? <p className="text-xs text-[var(--color-ok)]">{price.discountLabel}: − {formatBrlCents(discount)}</p> : null}
          </div>
          <button type="button" onClick={onBack} disabled={busy} className="shrink-0 rounded-lg px-2 py-1 text-sm font-semibold text-uno-red underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-uno-red disabled:opacity-50">Alterar plano ou cupom</button>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-[var(--color-line)] pt-3 text-sm">
          <div>
            <dt className="text-[var(--color-muted)]">Total hoje</dt>
            <dd className="font-heading text-xl font-extrabold tabular-nums" data-testid="total-today">{formatBrlCents(price.first)}</dd>
          </div>
          <div className="text-right">
            <dt className="text-[var(--color-muted)]">{laterLabel(price)}</dt>
            <dd className="font-heading text-xl font-extrabold tabular-nums" data-testid="recurring">{formatBrlCents(price.recurring)}<span className="text-sm font-semibold text-[var(--color-muted)]">/mês</span></dd>
          </div>
        </dl>
      </div>

      <section aria-label="Cartão de crédito">
        <PaymentFields flow={flow} organizationName="sua organização" adminDetail={config.adminDetail} disabled={coupon.applying} />
      </section>

      <div className="space-y-2 text-xs text-[var(--color-muted)]">
        <p className="flex gap-2"><ShieldCheck size={14} className="mt-0.5 shrink-0 text-[var(--color-ok)]" aria-hidden="true" /><span>Pagamento processado pela Stripe. A UNO não vê nem guarda o número do cartão.</span></p>
        <p className="flex gap-2"><Lock size={14} className="mt-0.5 shrink-0" aria-hidden="true" /><span>Cancele quando quiser em Configurações → Assinatura. O cartão fica guardado na Stripe para as renovações.</span></p>
        {flow.savedCard ? <p>Usando o cartão salvo {cardLabel(flow.savedCard)}.</p> : null}
      </div>
      <p className="text-center text-sm">
        <button type="button" onClick={onBack} disabled={busy} className="inline-flex items-center gap-1 text-[var(--color-muted)] underline-offset-4 hover:text-[var(--color-ink)] hover:underline disabled:opacity-50"><ArrowLeft size={14} aria-hidden="true" /> Voltar</button>
      </p>
    </div>
  );
}

const STEP_TEXT: Record<Step, { title: string; description: string }> = {
  loading: { title: "Crie sua conta para assinar", description: "Leva menos de um minuto. Depois você escolhe o cupom e paga, sem sair desta página." },
  auth: { title: "Crie sua conta para assinar", description: "Leva menos de um minuto. Depois você escolhe o cupom e paga, sem sair desta página." },
  summary: { title: "Confirme sua assinatura", description: "Revise o plano, aplique um cupom e siga para o pagamento seguro." },
  payment: { title: "Pagamento", description: "Digite o cartão aqui mesmo. A cobrança é feita pela Stripe." },
};

/**
 * The purchase flow over the plans (NEX-51, NEX-52): sign-up or sign-in, then
 * plan, coupon and price, then the card, all in this dialog without leaving
 * the page. Opens straight on the summary when there is already a session.
 *
 * The payment step is a non-modal dialog with its own backdrop and scroll
 * lock: Radix's modal focus trap and outside-pointer lock would fight Stripe's
 * 3D Secure and Link overlays, which Stripe.js appends to <body>, outside this
 * dialog. Focus moving to them never dismisses it, and while a payment is in
 * progress Esc, the backdrop and the close button only say so.
 */
export function PurchaseDialog({ plans, initialPlan, onClose }: { plans: PublicBillingPlan[]; initialPlan: PaidPlanId; onClose(): void }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("loading");
  const [billing, setBilling] = useState<BillingView>();
  const [config, setConfig] = useState<CheckoutConfig>();
  const [notice, setNotice] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const [selected, setSelected] = useState<PaidPlanId>(initialPlan);
  const [phase, setPhase] = useState<Phase>("idle");
  const [closeBlocked, setCloseBlocked] = useState(false);
  const started = useRef(false);
  const plan = plans.find((candidate) => candidate.id === initialPlan) ?? plans[0];
  const paid = paidPlans(billing, selected);

  const expire = useCallback((message: string) => { setNotice(message); setBilling(undefined); setPhase("idle"); setStep("auth"); }, []);
  const coupon = useCouponCheckout(paid.plan, expire);

  const loadSummary = useCallback(async (fromSession: boolean) => {
    setFailure(undefined);
    setStep("loading");
    try {
      const [response, configResponse] = await Promise.all([
        fetch("/api/dashboard/billing", { cache: "no-store" }),
        fetch("/api/dashboard/billing/checkout-config", { cache: "no-store" }),
      ]);
      const body: unknown = await response.json().catch(() => null);
      if (response.status === 401) {
        if (fromSession) expire("Sua sessão expirou. Entre novamente para continuar.");
        else setStep("auth");
        return;
      }
      if (!response.ok) {
        const parsed = errorEnvelope.safeParse(body);
        if (parsed.success && parsed.data.error.code === "organization_required") { router.push("/organization/new"); return; }
        throw new Error(parsed.success ? parsed.data.error.message : "");
      }
      if (!configResponse.ok) throw new Error("");
      setBilling(billingStateSchema.parse(body));
      setConfig(checkoutConfigSchema.parse(await configResponse.json()));
      setNotice(undefined);
      setStep("summary");
    } catch {
      setFailure("Não foi possível carregar os planos. Tente novamente.");
      setStep("summary");
    }
  }, [expire, router]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      const session = await authClient.getSession().catch(() => null);
      if (session?.data?.user) await loadSummary(true);
      else setStep("auth");
    })();
  }, [loadSummary]);

  const paymentStep = step === "payment";
  const busy = paymentStep && phase !== "idle" && phase !== "success";

  // Non-modal on the payment step (see above): keep the page behind from scrolling.
  useEffect(() => {
    if (!paymentStep) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [paymentStep]);

  const requestClose = () => {
    if (busy) { setCloseBlocked(true); return; }
    onClose();
  };
  const back = useCallback(() => { setPhase("idle"); setCloseBlocked(false); setStep("summary"); }, []);
  const trackPhase = useCallback((next: Phase) => {
    setPhase(next);
    if (next === "idle" || next === "success") setCloseBlocked(false);
  }, []);
  const select = (next: PaidPlanId) => { setSelected(next); void coupon.changePlan(next); };

  const text = phase === "success" && paymentStep
    ? { title: "Pagamento confirmado", description: "Seu plano já está ativo." }
    : STEP_TEXT[step];
  const stepIndex = phase === "success" && paymentStep ? 3 : step === "payment" ? 2 : step === "summary" ? 1 : 0;
  const placement = paymentStep
    // Phones: a full-height sheet with its own scroll, so the Payment Element and 3DS fit at 375px.
    ? "inset-0 h-dvh w-full rounded-none sm:inset-auto sm:left-1/2 sm:top-1/2 sm:h-auto sm:max-h-[92dvh] sm:w-[calc(100%-2rem)] sm:max-w-xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl"
    : "left-1/2 top-1/2 max-h-[92dvh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-2xl";

  return (
    <DialogPrimitive.Root open modal={!paymentStep} onOpenChange={(next) => { if (!next) requestClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        {paymentStep ? <div data-purchase-backdrop="" aria-hidden="true" className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" /> : null}
        {/* app-shell: the dialog is portaled outside the page, so it takes the app
            palette (light, or dark when the visitor chose it) and its button skins. */}
        <DialogPrimitive.Content
          aria-modal="true"
          className={`app-shell fixed z-50 overflow-y-auto overflow-x-hidden overscroll-contain border border-[var(--color-line)] p-5 text-[var(--color-ink)] shadow-2xl sm:p-6 ${placement}`}
          style={{ background: "var(--color-surface)" }}
          onEscapeKeyDown={(event) => { if (busy) { event.preventDefault(); setCloseBlocked(true); } }}
          onPointerDownOutside={(event) => {
            if (step === "loading") { event.preventDefault(); return; }
            if (!paymentStep) return;
            // Only our own backdrop closes the payment step, and never mid-payment.
            const target = event.target instanceof Element ? event.target : null;
            const onBackdrop = Boolean(target?.closest("[data-purchase-backdrop]"));
            if (!onBackdrop || busy) {
              event.preventDefault();
              if (onBackdrop) setCloseBlocked(true);
            }
          }}
          // Stripe's 3D Secure and Link frames take focus outside this dialog: that is not a dismissal.
          onFocusOutside={(event) => { if (paymentStep || step === "loading") event.preventDefault(); }}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <Steps current={stepIndex} />
              <DialogPrimitive.Title className="mt-4 font-heading text-xl font-bold">{text.title}</DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-1 text-sm text-[var(--color-muted)]">{text.description}</DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close asChild>
              <button type="button" className="rounded-full p-2 text-[var(--color-muted)] hover:bg-[var(--hover-ink)] hover:text-[var(--color-ink)] focus-visible:outline-2 focus-visible:outline-uno-red" aria-label="Fechar">
                <X size={18} />
              </button>
            </DialogPrimitive.Close>
          </div>
          {closeBlocked && busy ? (
            <div className="mt-4"><Alert tone="info">Pagamento em andamento. Aguarde a confirmação antes de fechar.</Alert></div>
          ) : null}
          <div className="mt-5">
            {step === "loading" || !plan ? (
              <p role="status" className="py-10 text-center text-sm text-[var(--color-muted)]">Carregando…</p>
            ) : step === "auth" ? (
              <AuthStep plan={plan} notice={notice} onSignedIn={() => void loadSummary(false)} />
            ) : failure || !billing || !config ? (
              <div className="space-y-4">
                <Alert>{failure ?? "Não foi possível carregar os planos. Tente novamente."}</Alert>
                <Button variant="secondary" className="w-full" onClick={() => void loadSummary(true)}>Tentar de novo</Button>
              </div>
            ) : step === "payment" && paid.plan ? (
              <PaymentStep billing={billing} plan={paid.plan} coupon={coupon} config={config} onBack={back} onPhase={trackPhase} onSessionExpired={expire} />
            ) : (
              <SummaryStep billing={billing} plans={paid.plans} plan={paid.plan} coupon={coupon} onSelect={select} onContinue={() => { setPhase("idle"); setStep("payment"); }} />
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * "Assinar" button for a paid plan. A plain link to sign-up until the page is
 * interactive (and for new tabs); a click then opens the purchase dialog here.
 */
export function PlanPurchaseButton({ planId, plans, children, variant = "primary", size = "md", className }: {
  planId: PaidPlanId;
  plans: PublicBillingPlan[];
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    setOpen(true);
  };
  return (
    <>
      <ButtonLink href={`/register?plan=${planId.toLowerCase()}`} variant={variant} size={size} className={className} onClick={onClick} aria-haspopup="dialog">{children}</ButtonLink>
      {open ? <PurchaseDialog plans={plans} initialPlan={planId} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
