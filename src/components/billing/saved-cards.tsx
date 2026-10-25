"use client";

import { CreditCard } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";

import { errorMessage, requestJson } from "@/components/settings/request";
import { Button, Modal } from "@/components/ui";
import { savedCardsSchema, type SavedCard } from "@/lib/billing-model";
import { cardExpiry, cardLabel } from "@/lib/checkout-labels";

/**
 * Cards Stripe keeps for the organization (NEX-52), shown from Stripe at render
 * time (brand, last four digits, expiry; the UNO stores none of it). "Trocar
 * cartão" opens the Stripe portal; "Remover" detaches the card through the UNO,
 * which refuses to remove the only card paying a live subscription.
 */
export function SavedCards({ portalAvailable }: { portalAvailable: boolean }) {
  const [cards, setCards] = useState<SavedCard[]>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [confirm, setConfirm] = useState<SavedCard>();
  const [busy, setBusy] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const lock = useRef(false);

  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      try {
        const body = savedCardsSchema.parse(await requestJson("/api/dashboard/billing/cards", { signal: abort.signal }));
        if (!abort.signal.aborted) { setCards(body.cards); setError(undefined); }
      } catch (cause) {
        if (!abort.signal.aborted && !(cause instanceof DOMException)) setError(errorMessage(cause, "Não foi possível consultar os cartões."));
      }
    })();
    return () => abort.abort();
  }, [refresh]);

  const openPortal = async () => {
    if (lock.current) return;
    lock.current = true; setBusy("portal"); setError(undefined);
    try {
      const body = await requestJson("/api/dashboard/billing/portal", { method: "POST", body: {} });
      const destination = new URL(z.object({ url: z.url() }).parse(body).url);
      if (destination.protocol !== "https:" || destination.hostname !== "billing.stripe.com") throw new Error("portal");
      window.location.assign(destination.href);
      return;
    } catch (cause) {
      setError(errorMessage(cause, "Não foi possível abrir o portal de cobrança."));
    }
    lock.current = false; setBusy(undefined);
  };

  const remove = async (card: SavedCard) => {
    if (lock.current) return;
    lock.current = true; setBusy(card.id); setError(undefined); setNotice(undefined);
    try {
      const body = z.object({ replacedBy: z.string().nullable() }).parse(await requestJson("/api/dashboard/billing/cards", { method: "DELETE", body: { paymentMethodId: card.id } }));
      const replacement = body.replacedBy ? cards?.find((candidate) => candidate.id === body.replacedBy) : undefined;
      setNotice(`Cartão ${cardLabel(card)} removido.${replacement ? ` As próximas cobranças vão para o ${cardLabel(replacement)}.` : ""}`);
      setConfirm(undefined);
      setRefresh((value) => value + 1);
    } catch (cause) {
      setConfirm(undefined);
      setError(errorMessage(cause, "Não foi possível remover o cartão."));
    } finally {
      lock.current = false; setBusy(undefined);
    }
  };

  const onlyPayer = confirm ? confirm.inUse && (cards?.length ?? 0) <= 1 : false;

  return (
    <section aria-labelledby="saved-cards-title" className="mt-6 border-t border-[var(--color-line)] pt-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id="saved-cards-title" className="text-sm font-semibold">Cartão salvo</h3>
        {portalAvailable ? <Button size="sm" variant="secondary" disabled={Boolean(busy)} onClick={() => void openPortal()}>{busy === "portal" ? "Abrindo…" : "Trocar cartão"}</Button> : null}
      </div>
      {error ? <p role="alert" className="mt-3 text-sm text-uno-red">{error}</p> : null}
      {notice ? <p role="status" className="mt-3 text-sm">{notice}</p> : null}
      {!cards && !error ? <p role="status" className="mt-3 text-sm text-[var(--color-muted)]">Consultando cartões…</p> : null}
      {cards && cards.length === 0 ? <p className="mt-3 text-sm text-[var(--color-muted)]">Nenhum cartão salvo. Ao assinar, você pode salvar o cartão para as próximas compras.</p> : null}
      {cards && cards.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {cards.map((card) => (
            <li key={card.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] px-3 py-2.5">
              <span className="flex min-w-0 items-center gap-3 text-sm">
                <CreditCard size={18} aria-hidden="true" className="shrink-0 text-[var(--color-muted)]" />
                <span>
                  <span className="font-semibold">{cardLabel(card)}</span>
                  <span className="text-[var(--color-muted)]"> · validade {cardExpiry(card)}</span>
                  {card.isDefault || card.inUse ? <span className="ml-2 rounded-full bg-[var(--color-ok-surface)] px-2 py-0.5 text-xs font-semibold text-[var(--color-ok)]">{card.inUse ? "Paga a assinatura" : "Padrão"}</span> : null}
                </span>
              </span>
              <Button size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => setConfirm(card)} aria-label={`Remover ${cardLabel(card)}`}>Remover</Button>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-3 text-xs text-[var(--color-muted)]">O cartão fica guardado pela Stripe, não pela UNO, para as renovações e novas compras. Remova quando quiser.</p>
      <Modal open={Boolean(confirm)} onClose={() => setConfirm(undefined)} title="Remover cartão?" description={confirm ? `${cardLabel(confirm)} deixa de ficar guardado na Stripe para esta organização.` : undefined}>
        {onlyPayer ? (
          <p className="text-sm">Este é o único cartão da sua assinatura ativa: sem ele, a próxima renovação falharia. Use <strong>Trocar cartão</strong> para cadastrar outro antes, ou cancele a assinatura.</p>
        ) : confirm?.inUse ? (
          <p className="text-sm">Este cartão paga sua assinatura. As próximas cobranças passam para o outro cartão salvo.</p>
        ) : (
          <p className="text-sm">As próximas compras vão pedir um cartão de novo, a menos que haja outro salvo.</p>
        )}
        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <Button variant="ghost" onClick={() => setConfirm(undefined)}>Manter cartão</Button>
          <Button disabled={onlyPayer || Boolean(busy)} aria-busy={busy === confirm?.id} onClick={() => confirm && void remove(confirm)}>{busy === confirm?.id ? "Removendo…" : "Remover cartão"}</Button>
        </div>
      </Modal>
    </section>
  );
}
