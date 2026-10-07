"use client";

import { useEffect, useRef, useState } from "react";

import { Button, EmptyState, Table, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui";
import { webhookDeliveryListSchema, type WebhookDelivery, type WebhookEndpoint, type WebhookEventType } from "@/lib/webhook-model";

import { deliveryErrorLabel, deliveryStatusLabels, eventLabels, formatDateTime } from "./webhook-labels";

const statusClass: Record<WebhookDelivery["status"], string> = {
  pending: "text-amber-300",
  processing: "text-amber-300",
  delivered: "text-emerald-400",
  failed: "text-red-300",
  canceled: "text-zinc-400",
};

function hostOf(url: string | undefined): string {
  if (!url) return "Endpoint removido";
  try { return new URL(url).host; } catch { return "Endpoint"; }
}

function outcome(item: WebhookDelivery): string {
  if (item.status === "delivered") return `HTTP ${item.lastResponseStatus ?? "2xx"}`;
  if (item.lastResponseStatus) return `HTTP ${item.lastResponseStatus}`;
  return deliveryErrorLabel(item.lastError);
}

export function WebhookDeliveryHistory({ endpoints, canRetry }: { endpoints: WebhookEndpoint[]; canRetry: boolean }) {
  const [items, setItems] = useState<WebhookDelivery[]>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [retrying, setRetrying] = useState<string>();
  const lock = useRef(false);

  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      setLoading(true);
      try {
        const parameters = new URLSearchParams({ limit: "20" });
        if (cursor) parameters.set("cursor", cursor);
        const response = await fetch(`/api/dashboard/webhooks/deliveries?${parameters}`, { signal: abort.signal, cache: "no-store" });
        if (!response.ok) throw new Error();
        const body = webhookDeliveryListSchema.parse(await response.json());
        if (abort.signal.aborted) return;
        setItems(current => cursor && current ? [...current, ...body.items.filter(item => !current.some(existing => existing.id === item.id))] : body.items);
        setNextCursor(body.nextCursor); setError(undefined);
      } catch {
        if (!abort.signal.aborted) setError("Não foi possível consultar as entregas. Tente atualizar.");
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    })();
    return () => abort.abort();
  }, [cursor, refresh]);

  const reload = () => { setCursor(undefined); setRefresh(value => value + 1); };
  const retry = async (item: WebhookDelivery) => {
    if (lock.current) return;
    lock.current = true; setRetrying(item.id); setError(undefined);
    try {
      const response = await fetch(`/api/dashboard/webhooks/deliveries/${item.id}/retry`, { method: "POST" });
      if (!response.ok) {
        let message = "Não foi possível reenviar a entrega.";
        try { const body: unknown = await response.json(); const candidate = (body as { error?: { message?: unknown } }).error?.message; if (typeof candidate === "string") message = candidate; } catch { /* keeps the default message */ }
        throw new Error(message);
      }
      reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível reenviar a entrega."); }
    finally { lock.current = false; setRetrying(undefined); }
  };

  const urls = new Map(endpoints.map(endpoint => [endpoint.id, endpoint.url]));
  return <section>
    <div className="flex justify-between gap-3"><div><h2 className="font-heading text-xl font-semibold">Entregas recentes</h2><p className="mt-2 text-sm text-zinc-400">Cada evento tem um envio inicial e até cinco novas tentativas: 1 min, 5 min, 30 min, 2 h e 12 h após a falha anterior.</p></div><Button variant="ghost" size="sm" disabled={loading} onClick={reload}>Atualizar</Button></div>
    {error ? <p role="alert" className="mt-5 text-sm text-red-300">{error}</p> : null}
    {!items ? (error ? null : <p role="status" className="mt-5 text-zinc-400">Consultando entregas…</p>) : !items.length ? <div className="mt-5"><EmptyState title="Nenhuma entrega registrada" description="As entregas aparecem aqui quando uma conversão ou um lote termina depois da criação do endpoint."/></div> : <div className="mt-5 rounded-xl border border-white/10">
      <Table aria-label="Histórico de entregas de webhook">
        <TableHeader><tr><TableHead>Evento</TableHead><TableHead>Destino</TableHead><TableHead>Situação</TableHead><TableHead>Tentativas</TableHead><TableHead>Última resposta</TableHead><TableHead>Próxima tentativa</TableHead><TableHead><span className="sr-only">Ações</span></TableHead></tr></TableHeader>
        <tbody>{items.map(item => <TableRow key={item.id}>
          <TableCell><p className="text-white">{eventLabels[item.eventType as WebhookEventType] ?? item.eventType}</p><p className="mt-1 text-xs text-zinc-500">{formatDateTime(item.createdAt)}</p><p className="mt-1 font-mono text-[11px] text-zinc-600" title="Identificador enviado em X-Label-Delivery">{item.id}</p></TableCell>
          <TableCell className="max-w-48 truncate font-mono text-xs">{hostOf(urls.get(item.endpointId))}</TableCell>
          <TableCell><span className={statusClass[item.status]}>{deliveryStatusLabels[item.status]}</span></TableCell>
          <TableCell>{item.attemptCount} de 6</TableCell>
          <TableCell>{item.attemptCount || item.lastError ? outcome(item) : "—"}</TableCell>
          <TableCell>{formatDateTime(item.nextAttemptAt)}</TableCell>
          <TableCell>{canRetry && item.canRetry && (item.status === "canceled" || item.attemptCount > 0) ? <Button variant="ghost" size="sm" disabled={Boolean(retrying)} aria-label={`Reenviar entrega ${item.id}`} onClick={() => void retry(item)}>{retrying === item.id ? "Aguarde…" : "Reenviar agora"}</Button> : null}</TableCell>
        </TableRow>)}</tbody>
      </Table>
    </div>}
    {nextCursor ? <div className="mt-4 flex justify-center"><Button variant="secondary" size="sm" disabled={loading} onClick={() => setCursor(nextCursor)}>{loading ? "Carregando…" : "Carregar mais"}</Button></div> : null}
  </section>;
}
