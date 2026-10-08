"use client";

import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui";
import { billingStateSchema } from "@/lib/billing-model";
import { formatBrlCents } from "@/lib/plans";

type BillingState = z.infer<typeof billingStateSchema>;
const statusLabels: Record<string, string> = { ACTIVE: "Ativa", TRIALING: "Em teste", INCOMPLETE: "Pagamento pendente", PAST_DUE: "Pagamento em atraso", UNPAID: "Pagamento pendente", PAUSED: "Pausada", CANCELED: "Cancelada" };
const ADDON_OPERATION = "addon:API";

function AddonCard({ billing, canManage, busy, onSubscribe }: { billing: BillingState; canManage: boolean; busy: string | undefined; onSubscribe: () => void }) {
  const addon = billing.apiAddon;
  const pending = !addon.active && !addon.inactiveWithoutPaidPlan && addon.status !== null && addon.status !== "CANCELED";
  return <section aria-label="Adicional de API" className={`rounded-2xl border bg-[#080808] p-6 ${addon.active ? "border-uno-red" : "border-white/10"}`}>
    <div className="flex flex-wrap items-start justify-between gap-6">
      <div className="max-w-2xl"><p className="text-sm font-semibold text-uno-red">Adicional opcional</p><h2 className="mt-2 font-heading text-xl font-bold">+ {addon.name}</h2><p className="mt-3 text-sm text-zinc-400">Chaves de API, API pública e webhooks para integrar a UNO ao seu sistema. Contratado à parte, em qualquer plano pago (Starter, Pro ou Business); o limite de requisições por minuto segue o do plano.</p></div>
      <p className="font-heading text-3xl font-bold">{formatBrlCents(addon.priceBrlCents)}<span className="text-sm font-normal text-zinc-500"> /mês</span></p>
    </div>
    <div className="mt-6 flex flex-wrap items-center gap-4">
      {addon.active ? <p className="text-sm font-semibold text-uno-red">Adicional ativo{addon.currentPeriodEnd ? ` · período até ${dateLabel(addon.currentPeriodEnd)}` : ""}</p>
        : addon.inactiveWithoutPaidPlan ? <p className="text-sm text-amber-300">O adicional está pago, mas inativo: a API só funciona com um plano pago ativo. Escolha um plano ou cancele o adicional no portal.</p>
        : pending ? <p className="text-sm text-amber-300">{statusLabels[addon.status ?? ""] ?? "Pagamento pendente"} — regularize o adicional em Gerenciar assinatura.</p>
        : addon.available ? <Button variant="secondary" disabled={Boolean(busy)} onClick={onSubscribe}>{busy === ADDON_OPERATION ? "Abrindo…" : `Contratar + ${addon.name}`}</Button>
        : <p className="text-sm text-zinc-500">{!canManage ? "Gerenciado pelo administrador" : billing.effectivePlanId === "FREE" ? "Disponível para os planos Starter, Pro e Business. Escolha um plano pago para contratar." : "O adicional ainda não está disponível nesta instalação."}</p>}
    </div>
    <p className="mt-4 text-xs text-zinc-500">O adicional é uma assinatura mensal própria. Para cancelar, use Gerenciar assinatura (portal do cliente).</p>
  </section>;
}

function dateLabel(value: string | null): string { return value ? new Date(value).toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "Sem período contratado"; }

export function BillingPanel({ canManage }: { canManage: boolean }) {
  const [billing, setBilling] = useState<BillingState>();
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState<string>();
  const operationKeys = useRef(new Map<string, string>());
  const locked = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/dashboard/billing", { signal: controller.signal, cache: "no-store" });
        const body = await response.json();
        if (!response.ok) throw new Error(typeof body.error?.message === "string" ? body.error.message : "Não foi possível consultar a assinatura.");
        const state = billingStateSchema.parse(body);
        if (!controller.signal.aborted) { setBilling(state); setError(undefined); }
      } catch { if (!controller.signal.aborted) setError("Não foi possível consultar a assinatura. Tente atualizar."); }
    })();
    return () => controller.abort();
  }, [refresh]);

  // `target` is a paid plan id, the "addon:API" checkout, or nothing for the customer portal.
  const openBilling = async (target?: string) => {
    if (locked.current || !canManage) return;
    const operation = target ?? "portal";
    locked.current = true; setBusy(operation); setError(undefined);
    try {
      const key = operationKeys.current.get(operation) ?? crypto.randomUUID();
      operationKeys.current.set(operation, key);
      const response = await fetch(`/api/dashboard/billing/${target ? "checkout" : "portal"}`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(target === ADDON_OPERATION ? { addon: "API" } : target ? { planId: target } : {}) });
      const body = await response.json();
      if (!response.ok) throw new Error(typeof body.error?.message === "string" ? body.error.message : "Não foi possível abrir a cobrança.");
      const destination = new URL(z.object({ url: z.url() }).parse(body).url);
      if (destination.protocol !== "https:" || destination.username || destination.password || !["checkout.stripe.com", "billing.stripe.com"].includes(destination.hostname)) throw new Error("Não foi possível abrir a cobrança.");
      window.location.assign(destination.href);
    } catch (cause) { setError(cause instanceof z.ZodError ? "Não foi possível abrir a cobrança." : cause instanceof Error ? cause.message : "Não foi possível abrir a cobrança."); }
    finally { locked.current = false; setBusy(undefined); }
  };

  return <div className="mt-8 space-y-8">
    {error ? <p role="alert" className="text-sm text-red-300">{error}</p> : null}
    <section className="rounded-2xl border border-white/10 bg-[#080808] p-6">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="font-heading text-xl font-semibold">Plano atual</h2>{billing ? <><p className="mt-3 text-zinc-300">{billing.plans.find(plan => plan.id === billing.effectivePlanId)?.name ?? billing.effectivePlanId}</p><p className="mt-2 text-sm text-zinc-500">{statusLabels[billing.status] ?? "Free"} · Período: {dateLabel(billing.currentPeriodStart)} — {dateLabel(billing.currentPeriodEnd)}</p>{billing.cancelAtPeriodEnd ? <p className="mt-2 text-sm text-amber-300">Cancelamento agendado para o fim do período.</p> : null}</> : <p role="status" className="mt-3 text-zinc-400">Consultando assinatura…</p>}</div><div className="flex flex-wrap gap-3"><Button size="sm" variant="ghost" onClick={() => setRefresh(value => value + 1)}>Atualizar</Button>{billing?.portalAvailable && canManage ? <Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => void openBilling()}>{busy === "portal" ? "Abrindo…" : "Gerenciar assinatura"}</Button> : null}</div></div>
      {!canManage ? <p className="mt-4 text-sm text-zinc-400">O proprietário ou administrador da organização gerencia a assinatura.</p> : billing && !billing.checkoutAvailable && !billing.portalAvailable ? <p className="mt-4 text-sm text-zinc-400">A cobrança ainda não está configurada para esta instalação.</p> : null}
    </section>
    {billing ? <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4" aria-label="Planos disponíveis">{billing.plans.map(plan => <article key={plan.id} className={`flex flex-col rounded-2xl border bg-[#080808] p-6 ${plan.id === billing.effectivePlanId ? "border-uno-red" : "border-white/10"}`}><h2 className="font-heading text-xl font-bold">{plan.name}</h2><p className="mt-4 font-heading text-3xl font-bold">{formatBrlCents(plan.priceBrlCents)}<span className="text-sm font-normal text-zinc-500"> /mês</span></p><ul className="mt-5 flex-1 space-y-3 text-sm text-zinc-400"><li>{plan.monthlyLimit.toLocaleString("pt-BR")} etiquetas por mês</li><li>Até {plan.maxFileMB} MB por arquivo</li><li>Lotes de até {plan.batchLimit} arquivos</li><li>Retenção de {plan.retentionDays} dias</li><li>{plan.id === "FREE" ? "Conversões pelo painel" : `API e webhooks com o adicional + API · ${plan.rateLimit} req/min`}</li></ul>{plan.id === billing.effectivePlanId ? <p className="mt-6 text-sm font-semibold text-uno-red">Seu plano atual</p> : plan.id !== "FREE" && canManage ? <Button className="mt-6" variant="secondary" disabled={Boolean(busy) || !billing.checkoutAvailable && !billing.portalAvailable} onClick={() => void openBilling(billing.checkoutAvailable ? plan.id : undefined)}>{busy === plan.id || busy === "portal" ? "Abrindo…" : billing.checkoutAvailable ? `Escolher ${plan.name}` : "Alterar no portal"}</Button> : <p className="mt-6 text-xs text-zinc-500">{plan.id === "FREE" ? billing.portalAvailable ? "Cancelamento disponível no portal" : "Plano sem mensalidade" : "Gerenciado pelo administrador"}</p>}</article>)}</section> : null}
    {billing ? <AddonCard billing={billing} canManage={canManage} busy={busy} onSubscribe={() => void openBilling(ADDON_OPERATION)} /> : null}
  </div>;
}
