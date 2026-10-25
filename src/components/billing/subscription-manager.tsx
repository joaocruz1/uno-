"use client";

import { useEffect, useRef, useState } from "react";
import { z } from "zod";

import { Button, Modal } from "@/components/ui";
import { billingStateSchema, refundEligibilitySchema, refundResultSchema, type RefundEligibility } from "@/lib/billing-model";
import { formatBrlCents } from "@/lib/plans";

type BillingState = z.infer<typeof billingStateSchema>;
type Operation = "cancel" | "resume" | "refund";

const TIME_ZONE = "America/Sao_Paulo";

export function shortDate(value: string | null): string {
  return value ? new Date(value).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", timeZone: TIME_ZONE }) : "—";
}

export function fullDate(value: string | null): string {
  return value ? new Date(value).toLocaleDateString("pt-BR", { timeZone: TIME_ZONE }) : "—";
}

/** Same-origin billing POST with an Idempotency-Key reused until the operation succeeds. */
export async function postBilling(path: string, key: string, body: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`/api/dashboard/billing/${path}`, {
      method: "POST", cache: "no-store",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Sem conexão com o servidor. Verifique sua rede e tente novamente.");
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = (payload as { error?: { message?: unknown } } | undefined)?.error?.message;
    throw new Error(typeof message === "string" ? message : "Não foi possível concluir a solicitação. Tente novamente.");
  }
  return payload;
}

/**
 * Cancel, resume and 7-day refund for the card plan subscription. Members see
 * the state only; prepaid PIX days are shown as information, never refunded here.
 */
export function SubscriptionManager({ billing, canManage, onChanged }: { billing: BillingState; canManage: boolean; onChanged: () => void }) {
  const [refund, setRefund] = useState<RefundEligibility>();
  const [dialog, setDialog] = useState<Operation>();
  const [alsoAddon, setAlsoAddon] = useState(true);
  const [busy, setBusy] = useState<Operation>();
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string }>();
  const keys = useRef(new Map<Operation, string>());
  const lock = useRef(false);
  const hasCard = billing.management.changePlan || billing.management.cancel || billing.management.resume;
  const addonLive = billing.apiAddon.status === "ACTIVE" || billing.apiAddon.status === "TRIALING";
  const planName = billing.plans.find((plan) => plan.id === billing.effectivePlanId)?.name ?? billing.effectivePlanId;

  useEffect(() => {
    if (!canManage) return;
    const abort = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/dashboard/billing/refund", { signal: abort.signal, cache: "no-store" });
        if (!response.ok) return;
        const eligibility = refundEligibilitySchema.parse(await response.json());
        if (!abort.signal.aborted) setRefund(eligibility);
      } catch { /* Eligibility is optional: without it the refund is simply not offered. */ }
    })();
    return () => abort.abort();
  }, [canManage, billing]);

  const run = async (operation: Operation) => {
    if (lock.current || !canManage) return;
    lock.current = true; setBusy(operation); setMessage(undefined);
    try {
      const key = keys.current.get(operation) ?? crypto.randomUUID();
      keys.current.set(operation, key);
      if (operation === "refund") {
        const result = refundResultSchema.parse(await postBilling("refund", key, {}));
        setMessage({ kind: "ok", text: `Reembolso de ${formatBrlCents(result.refundedBrlCents)} solicitado. O estorno aparece na fatura do cartão em alguns dias úteis; a conta voltou ao plano Free.` });
      } else {
        await postBilling(operation, key, { alsoAddon: addonLive ? alsoAddon : false });
        setMessage({ kind: "ok", text: operation === "cancel" ? `Cancelamento agendado. Você mantém o plano ${planName} até ${fullDate(billing.currentPeriodEnd)}.` : "Cancelamento desfeito. A assinatura segue renovando normalmente." });
      }
      keys.current.delete(operation);
      setDialog(undefined);
      onChanged();
    } catch (cause) {
      setMessage({ kind: "error", text: cause instanceof Error && !(cause instanceof z.ZodError) ? cause.message : "Não foi possível concluir a solicitação. Tente novamente." });
      setDialog(undefined);
    } finally {
      lock.current = false; setBusy(undefined);
    }
  };

  const refundOffered = canManage && refund?.eligible === true;

  return (
    <div className="space-y-4">
      {billing.prepaid ? (
        <p className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-2)] p-4 text-sm text-[var(--color-muted)]">
          Crédito pré-pago (PIX ou indicação) no plano {billing.plans.find((plan) => plan.id === billing.prepaid?.planId)?.name ?? billing.prepaid.planId} até {fullDate(billing.prepaid.periodEnd)}. Ele não renova sozinho, não é cancelado nem reembolsado por aqui; para dúvidas sobre um pagamento PIX, fale com o suporte.
        </p>
      ) : null}

      {hasCard ? (
        <div className="flex flex-wrap items-center gap-3">
          {billing.cancelAtPeriodEnd
            ? <p className="text-sm text-[var(--color-ink)]">Cancelamento agendado: você mantém o plano {planName} até {fullDate(billing.currentPeriodEnd)}.</p>
            : <p className="text-sm text-[var(--color-muted)]">Renova automaticamente em {fullDate(billing.currentPeriodEnd)}.</p>}
          {canManage && billing.management.cancel ? <Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => { setAlsoAddon(true); setDialog("cancel"); }}>Cancelar assinatura</Button> : null}
          {canManage && billing.management.resume ? <Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => { setAlsoAddon(true); setDialog("resume"); }}>{busy === "resume" ? "Aguarde…" : "Manter assinatura"}</Button> : null}
          {refundOffered ? <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => setDialog("refund")}>{refund?.inProgress ? "Concluir reembolso" : `Solicitar reembolso (até ${shortDate(refund?.deadline ?? null)})`}</Button> : null}
        </div>
      ) : refundOffered && refund?.inProgress ? (
        <Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => setDialog("refund")}>Concluir reembolso</Button>
      ) : null}

      {!canManage && hasCard ? <p className="text-sm text-[var(--color-muted)]">Somente o proprietário ou um administrador cancela, troca de plano ou pede reembolso.</p> : null}
      {message ? <p role={message.kind === "error" ? "alert" : "status"} className={`text-sm ${message.kind === "error" ? "text-uno-red" : "text-[var(--color-ink)]"}`}>{message.text}</p> : null}

      <Modal open={dialog === "cancel"} onClose={() => setDialog(undefined)} title="Cancelar assinatura?" description={`A cobrança para de renovar. Você mantém o plano ${planName} e a cota atual até ${fullDate(billing.currentPeriodEnd)}; depois a conta volta ao plano Free.`}>
        {addonLive ? (
          <label className="flex items-start gap-3 text-sm text-[var(--color-ink)]">
            <input type="checkbox" className="mt-1 size-4 accent-uno-red" checked={alsoAddon} onChange={(event) => setAlsoAddon(event.target.checked)} />
            <span>Cancelar também o + {billing.apiAddon.name}. <span className="text-[var(--color-muted)]">Sem plano pago, o adicional deixa de funcionar de qualquer forma.</span></span>
          </label>
        ) : null}
        <p className="mt-4 text-xs text-[var(--color-muted)]">Você pode desfazer o cancelamento até o fim do período.</p>
        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <Button variant="ghost" onClick={() => setDialog(undefined)}>Voltar</Button>
          <Button disabled={Boolean(busy)} onClick={() => void run("cancel")}>{busy === "cancel" ? "Cancelando…" : "Confirmar cancelamento"}</Button>
        </div>
      </Modal>

      <Modal open={dialog === "resume"} onClose={() => setDialog(undefined)} title="Manter a assinatura?" description={`O cancelamento agendado é desfeito e o plano ${planName} volta a renovar em ${fullDate(billing.currentPeriodEnd)}.`}>
        {addonLive ? (
          <label className="flex items-start gap-3 text-sm text-[var(--color-ink)]">
            <input type="checkbox" className="mt-1 size-4 accent-uno-red" checked={alsoAddon} onChange={(event) => setAlsoAddon(event.target.checked)} />
            <span>Manter também o + {billing.apiAddon.name}.</span>
          </label>
        ) : null}
        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <Button variant="ghost" onClick={() => setDialog(undefined)}>Voltar</Button>
          <Button disabled={Boolean(busy)} onClick={() => void run("resume")}>{busy === "resume" ? "Aguarde…" : "Manter assinatura"}</Button>
        </div>
      </Modal>

      <Modal open={dialog === "refund"} onClose={() => setDialog(undefined)} title="Solicitar reembolso?" description="Direito de arrependimento: até 7 dias após o primeiro pagamento, uma vez por organização.">
        <ul className="list-disc space-y-2 pl-5 text-sm text-[var(--color-ink)]">
          <li>Estorno integral de {formatBrlCents(refund?.amountBrlCents ?? 0)} no cartão usado{addonLive ? `, incluindo o + ${billing.apiAddon.name}` : ""}.</li>
          <li>A assinatura é encerrada agora e a conta volta ao plano Free, com a cota do Free.</li>
          {addonLive ? <li>Chaves de API e webhooks deixam de funcionar imediatamente.</li> : null}
          <li>Esta organização não poderá pedir outro reembolso de 7 dias.</li>
        </ul>
        <p className="mt-4 text-xs text-[var(--color-muted)]">O estorno costuma aparecer na fatura em 5 a 10 dias úteis, conforme o banco emissor.</p>
        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <Button variant="ghost" onClick={() => setDialog(undefined)}>Voltar</Button>
          <Button disabled={Boolean(busy)} onClick={() => void run("refund")}>{busy === "refund" ? "Processando…" : "Confirmar reembolso"}</Button>
        </div>
      </Modal>
    </div>
  );
}
