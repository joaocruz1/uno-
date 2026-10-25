"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ArrowRight, Check, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { z } from "zod";

import { friendlyAuthError } from "@/components/auth/auth-errors";
import { PhoneInput } from "@/components/auth/phone-input";
import { Button, ButtonLink } from "@/components/ui";
import { authClient } from "@/lib/auth-client";
import { billingStateSchema, type BillingView, type PaidPlanId, type PublicBillingPlan } from "@/lib/billing-model";
import { normalizeBrPhone, PHONE_INVALID_MESSAGE, PHONE_REQUIRED_MESSAGE } from "@/lib/phone";
import { formatBrlCents } from "@/lib/plans";

import { CouponField, hasPromo, planFeatures, PriceBreakdown, SecurePaymentNote, useCouponCheckout } from "./checkout-summary";

const PAID: readonly PaidPlanId[] = ["STARTER", "PRO", "BUSINESS"];
const inputClass = "mt-2 h-11 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] px-3 text-base text-[var(--color-ink)] outline-none transition placeholder:text-[var(--color-faint)] focus:border-uno-red/70 focus:ring-2 focus:ring-uno-red/20 disabled:opacity-60 sm:text-sm";
const labelClass = "block text-sm font-medium text-[var(--color-ink)]";
const errorEnvelope = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

type Step = "loading" | "auth" | "summary";
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

function Steps({ step }: { step: Step }) {
  const labels = ["Conta", "Plano e cupom", "Pagamento"];
  const current = step === "summary" ? 1 : 0;
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

/** Plan, coupon and price breakdown, then the existing Checkout API and Stripe. */
function SummaryStep({ billing, initialPlan, onSessionExpired }: { billing: BillingView; initialPlan: PaidPlanId; onSessionExpired(message: string): void }) {
  const plans = billing.plans.filter((candidate) => (PAID as readonly string[]).includes(candidate.id));
  const [selected, setSelected] = useState<PaidPlanId>(plans.some((plan) => plan.id === initialPlan) ? initialPlan : "PRO");
  const plan = plans.find((candidate) => candidate.id === selected) ?? plans[0];
  const checkout = useCouponCheckout(plan, onSessionExpired);
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
  const purchasable = billing.canManage && billing.billingConfigured && billing.checkoutAvailable;

  return (
    <div className="space-y-5">
      <fieldset>
        <legend className="text-sm font-medium text-[var(--color-muted)]">Plano</legend>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {plans.map((candidate) => {
            const active = candidate.id === plan.id;
            return (
              <label key={candidate.id} className={`relative flex cursor-pointer flex-col rounded-xl border px-3 py-2.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-uno-red ${active ? "border-uno-red bg-uno-red/[.06]" : "border-[var(--color-line)] hover:border-[var(--color-line-strong)]"}`}>
                <input type="radio" name={`${groupId}-plan`} value={candidate.id} checked={active} disabled={checkout.paying} onChange={() => { setSelected(candidate.id as PaidPlanId); void checkout.changePlan(candidate.id as PaidPlanId); }} className="sr-only" />
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
      <CouponField checkout={checkout} disabled={checkout.paying} idPrefix={`${groupId}-coupon`} />
      <div className="border-t border-[var(--color-line)] pt-4" aria-live="polite">
        <PriceBreakdown plan={plan} preview={checkout.preview} />
      </div>
      {checkout.payError ? <Alert>{checkout.payError}</Alert> : null}
      {!billing.canManage ? (
        <Alert tone="info">Só o proprietário ou um administrador da organização pode contratar um plano.</Alert>
      ) : !billing.billingConfigured ? (
        <Alert tone="info">A cobrança ainda não está configurada para esta instalação.</Alert>
      ) : manageable ? (
        <Alert tone="info">Sua organização já tem uma assinatura no cartão. <Link href="/dashboard/billing" className="font-semibold text-uno-red underline-offset-4 hover:underline">Gerencie em Assinatura</Link>.</Alert>
      ) : null}
      <div>
        <Button size="lg" className="w-full" disabled={!purchasable || checkout.paying} aria-busy={checkout.paying} onClick={() => void checkout.pay()}>
          {checkout.paying ? "Abrindo o pagamento…" : <>Ir para o pagamento <ArrowRight size={16} aria-hidden="true" /></>}
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
 * The purchase flow over the plans (NEX-51): sign-up or sign-in, then plan,
 * coupon and price, then Stripe, without leaving the page. Opens straight on
 * the summary when there is already a session.
 */
export function PurchaseDialog({ plans, initialPlan, onClose }: { plans: PublicBillingPlan[]; initialPlan: PaidPlanId; onClose(): void }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>("loading");
  const [billing, setBilling] = useState<BillingView>();
  const [notice, setNotice] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const started = useRef(false);
  const plan = plans.find((candidate) => candidate.id === initialPlan) ?? plans[0];

  const expire = useCallback((message: string) => { setNotice(message); setBilling(undefined); setStep("auth"); }, []);

  const loadSummary = useCallback(async (fromSession: boolean) => {
    setFailure(undefined);
    setStep("loading");
    try {
      const response = await fetch("/api/dashboard/billing", { cache: "no-store" });
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
      setBilling(billingStateSchema.parse(body));
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

  const title = step === "summary" ? "Confirme sua assinatura" : "Crie sua conta para assinar";
  const description = step === "summary" ? "Revise o plano, aplique um cupom e siga para o pagamento seguro." : "Leva menos de um minuto. Depois você escolhe o cupom e paga, sem sair desta página.";

  return (
    <DialogPrimitive.Root open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        {/* app-shell: the dialog is portaled outside the page, so it takes the app
            palette (light, or dark when the visitor chose it) and its button skins. */}
        <DialogPrimitive.Content
          className="app-shell fixed left-1/2 top-1/2 z-50 max-h-[92dvh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-[var(--color-line)] p-5 text-[var(--color-ink)] shadow-2xl sm:p-6"
          style={{ background: "var(--color-surface)" }}
          onInteractOutside={(event) => { if (step === "loading") event.preventDefault(); }}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <Steps step={step} />
              <DialogPrimitive.Title className="mt-4 font-heading text-xl font-bold">{title}</DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-1 text-sm text-[var(--color-muted)]">{description}</DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close asChild>
              <button type="button" className="rounded-full p-2 text-[var(--color-muted)] hover:bg-[var(--hover-ink)] hover:text-[var(--color-ink)] focus-visible:outline-2 focus-visible:outline-uno-red" aria-label="Fechar">
                <X size={18} />
              </button>
            </DialogPrimitive.Close>
          </div>
          <div className="mt-5">
            {step === "loading" || !plan ? (
              <p role="status" className="py-10 text-center text-sm text-[var(--color-muted)]">Carregando…</p>
            ) : step === "auth" ? (
              <AuthStep plan={plan} notice={notice} onSignedIn={() => void loadSummary(false)} />
            ) : failure || !billing ? (
              <div className="space-y-4">
                <Alert>{failure ?? "Não foi possível carregar os planos. Tente novamente."}</Alert>
                <Button variant="secondary" className="w-full" onClick={() => void loadSummary(true)}>Tentar de novo</Button>
              </div>
            ) : (
              <SummaryStep billing={billing} initialPlan={initialPlan} onSessionExpired={expire} />
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
