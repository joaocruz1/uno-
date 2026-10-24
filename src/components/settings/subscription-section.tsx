"use client";

import { useEffect, useState } from "react";

import { SubscriptionManager } from "@/components/billing/subscription-manager";
import { ButtonLink, LoadingState } from "@/components/ui";
import { billingStateSchema, type BillingView } from "@/lib/billing-model";

import { errorMessage, requestJson } from "./request";

const STATUS_LABELS: Record<string, string> = { ACTIVE: "Ativa", TRIALING: "Em teste", INCOMPLETE: "Pagamento pendente", PAST_DUE: "Pagamento em atraso", UNPAID: "Pagamento pendente", PAUSED: "Pausada", CANCELED: "Cancelada" };

/** Plan summary with cancel/resume/refund; plan choice and the add-on live on /dashboard/billing. */
export function SubscriptionSection({ canManage }: { canManage: boolean }) {
  const [billing, setBilling] = useState<BillingView>();
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      try {
        const body = billingStateSchema.parse(await requestJson("/api/dashboard/billing", { signal: abort.signal }));
        if (!abort.signal.aborted) { setBilling(body); setError(undefined); }
      } catch (cause) {
        if (!abort.signal.aborted) setError(errorMessage(cause, "Não foi possível consultar a assinatura."));
      }
    })();
    return () => abort.abort();
  }, [refresh]);

  const plan = billing?.plans.find((item) => item.id === billing.effectivePlanId);
  const hasCard = billing ? billing.management.changePlan || billing.management.cancel || billing.management.resume : false;

  return (
    <section className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-surface)] p-6" aria-labelledby="subscription-title">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 id="subscription-title" className="font-heading text-xl font-semibold">Assinatura</h2>
          {billing ? (
            <p className="mt-2 text-sm text-[var(--color-muted)]">
              Plano <span className="font-semibold text-[var(--color-ink)]">{plan?.name ?? billing.effectivePlanId}</span>
              {hasCard ? ` · ${STATUS_LABELS[billing.status] ?? billing.status}` : ""}
              {billing.apiAddon.active ? ` · + ${billing.apiAddon.name} ativo` : ""}
            </p>
          ) : null}
        </div>
        <ButtonLink href="/dashboard/billing" size="sm" variant="secondary">{canManage ? "Trocar de plano" : "Ver planos"}</ButtonLink>
      </div>
      <div className="mt-5">
        {error ? <p role="alert" className="text-sm text-uno-red">{error}</p>
          : !billing ? <LoadingState label="Consultando assinatura" />
          : <SubscriptionManager billing={billing} canManage={canManage} onChanged={() => setRefresh((value) => value + 1)} />}
        {billing && !hasCard && !billing.prepaid ? <p className="text-sm text-[var(--color-muted)]">Sem assinatura no cartão. Escolha um plano pago na página de planos.</p> : null}
      </div>
    </section>
  );
}
