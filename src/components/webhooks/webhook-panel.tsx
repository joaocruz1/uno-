"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { z } from "zod";

import { Button, Dialog, EmptyState, Input, Modal } from "@/components/ui";
import {
  WEBHOOK_EVENT_TYPES,
  webhookEndpointCreatedSchema,
  webhookEndpointListSchema,
  type WebhookEndpoint,
  type WebhookEndpointCreated,
  type WebhookEndpointList,
  type WebhookEventType,
} from "@/lib/webhook-model";

import { WebhookDeliveryHistory } from "./webhook-delivery-history";
import { eventLabels, formatDateTime } from "./webhook-labels";

async function errorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body: unknown = await response.json();
    const message = (body as { error?: { message?: unknown } }).error?.message;
    return typeof message === "string" ? message : fallback;
  } catch {
    return fallback;
  }
}

export function WebhookPanel({ canManage, webhooksAvailable }: { canManage: boolean; webhooksAvailable: boolean }) {
  const [endpoints, setEndpoints] = useState<WebhookEndpointList>();
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<WebhookEventType[]>([...WEBHOOK_EVENT_TYPES]);
  const [secret, setSecret] = useState<WebhookEndpointCreated>();
  const [showSecret, setShowSecret] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string>();
  const [error, setError] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [remove, setRemove] = useState<WebhookEndpoint>();
  const [disable, setDisable] = useState<WebhookEndpoint>();
  const lock = useRef(false);
  const urlInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!canManage) return;
    const abort = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/dashboard/webhooks", { signal: abort.signal, cache: "no-store" });
        if (!response.ok) throw new Error();
        const body = webhookEndpointListSchema.parse(await response.json());
        if (!abort.signal.aborted) { setEndpoints(body); setLoadError(undefined); }
      } catch {
        if (!abort.signal.aborted) setLoadError("Não foi possível consultar os endpoints. Tente atualizar.");
      }
    })();
    return () => abort.abort();
  }, [canManage, refresh]);

  const run = async (work: () => Promise<void>, fallback: string) => {
    if (lock.current || !canManage) return;
    lock.current = true; setBusy(true); setError(undefined);
    try { await work(); }
    catch (cause) { setError(cause instanceof z.ZodError ? "Não foi possível confirmar a operação. Atualize a lista." : cause instanceof Error && cause.message ? cause.message : fallback); }
    finally { lock.current = false; setBusy(false); setRefresh(value => value + 1); }
  };

  const create = () => run(async () => {
    const response = await fetch("/api/dashboard/webhooks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: url.trim(), events }) });
    if (!response.ok) throw new Error(await errorMessage(response, "Não foi possível criar o endpoint."));
    let created: WebhookEndpointCreated;
    try { created = webhookEndpointCreatedSchema.parse(await response.json()); }
    catch { throw new Error("Não foi possível confirmar a criação. Atualize a lista e exclua o endpoint se não recebeu o segredo."); }
    setSecret(created); setShowSecret(false); setCopied(false); setCopyError(undefined); setUrl("");
  }, "Não foi possível criar o endpoint.");

  const setActive = (endpoint: WebhookEndpoint, active: boolean) => run(async () => {
    const response = await fetch(`/api/dashboard/webhooks/${endpoint.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ active }) });
    if (!response.ok) throw new Error(await errorMessage(response, "Não foi possível atualizar o endpoint."));
  }, "Não foi possível atualizar o endpoint.");

  const destroy = (endpoint: WebhookEndpoint) => run(async () => {
    const response = await fetch(`/api/dashboard/webhooks/${endpoint.id}`, { method: "DELETE" });
    if (!response.ok) throw new Error(await errorMessage(response, "Não foi possível excluir o endpoint."));
  }, "Não foi possível excluir o endpoint.");

  const copy = async () => {
    if (!secret) return;
    try { await navigator.clipboard.writeText(secret.secret); setCopied(true); setCopyError(undefined); }
    catch { setCopyError("Selecione e copie o valor do segredo manualmente."); }
  };
  const closeSecret = () => { setSecret(undefined); setShowSecret(false); setCopied(false); };
  const toggleEvent = (event: WebhookEventType) => setEvents(current => current.includes(event) ? current.filter(item => item !== event) : WEBHOOK_EVENT_TYPES.filter(item => item === event || current.includes(item)));

  if (!canManage) return <section className="mt-8 rounded-2xl border border-white/10 bg-[#080808] p-6"><p className="text-sm text-zinc-400">O proprietário ou administrador da organização gerencia os webhooks.</p><Link href="/docs" className="mt-4 inline-block text-sm text-uno-red">Consultar documentação</Link></section>;

  const activeCount = endpoints?.items.filter(item => item.active).length ?? 0;
  const atLimit = Boolean(endpoints && activeCount >= endpoints.maxActiveEndpoints);
  return <div className="mt-8 space-y-8">
    <section className="rounded-2xl border border-white/10 bg-[#080808] p-6">
      <div className="flex flex-wrap justify-between gap-4">
        <div><h2 className="font-heading text-xl font-semibold">Novo endpoint</h2><p className="mt-2 text-sm text-zinc-400">{webhooksAvailable ? `Use uma URL HTTPS pública. ${endpoints ? `${activeCount} de ${endpoints.maxActiveEndpoints} endpoints ativos.` : ""}` : "Os webhooks exigem o adicional + API, contratado em qualquer plano pago. Você pode desativar ou excluir endpoints existentes."}</p></div>
        <Link href={webhooksAvailable ? "/docs" : "/dashboard/billing"} className="text-sm text-uno-red underline">{webhooksAvailable ? "Como verificar a assinatura" : "Contratar o adicional de API"}</Link>
      </div>
      {webhooksAvailable ? <form className="mt-6 space-y-5" onSubmit={event => { event.preventDefault(); void create(); }}>
        <label className="block text-sm text-zinc-400">URL de destino<Input ref={urlInput} className="mt-2" type="url" inputMode="url" value={url} maxLength={2048} required placeholder="https://erp.suaempresa.com.br/webhooks/uno" autoComplete="off" disabled={busy} onChange={event => setUrl(event.target.value)}/></label>
        <fieldset><legend className="text-sm text-zinc-400">Eventos</legend><div className="mt-3 flex flex-wrap gap-x-6 gap-y-3">{WEBHOOK_EVENT_TYPES.map(event => <label key={event} className="flex items-center gap-2 text-sm text-zinc-300"><input type="checkbox" className="size-4 accent-[#ef233c]" checked={events.includes(event)} disabled={busy} onChange={() => toggleEvent(event)}/>{eventLabels[event]}<span className="font-mono text-xs text-zinc-500">{event}</span></label>)}</div></fieldset>
        {atLimit ? <p className="text-sm text-zinc-400">O limite de endpoints ativos foi atingido. Desative ou exclua um endpoint para criar outro.</p> : null}
        <Button type="submit" disabled={busy || !url.trim() || !events.length || atLimit}>{busy ? "Aguarde…" : "Criar endpoint"}</Button>
      </form> : null}
      {error ? <p role="alert" className="mt-5 text-sm text-red-300">{error}</p> : null}
    </section>

    <section>
      <div className="flex justify-between gap-3"><h2 className="font-heading text-xl font-semibold">Endpoints da organização</h2><Button variant="ghost" size="sm" disabled={busy} onClick={() => setRefresh(value => value + 1)}>Atualizar</Button></div>
      {loadError ? <p role="alert" className="mt-5 text-sm text-red-300">{loadError}</p> : null}
      {!endpoints ? (loadError ? null : <p role="status" className="mt-5 text-zinc-400">Consultando endpoints…</p>) : !endpoints.items.length ? <div className="mt-5"><EmptyState title="Nenhum endpoint criado" description="Crie um endpoint para que a UNO avise seu sistema quando o processamento terminar."/></div> : <ul className="mt-5 divide-y divide-white/10 rounded-xl border border-white/10">{endpoints.items.map(item => <li key={item.id} className="flex flex-wrap items-center justify-between gap-4 p-5">
        <div className="min-w-0 flex-1"><p className="truncate font-mono text-sm" title={item.url}>{item.url}</p><p className="mt-2 text-xs text-zinc-500"><span className={item.active ? "text-emerald-400" : "text-zinc-400"}>{item.active ? "Ativo" : "Desativado"}</span> · {item.events.map(event => eventLabels[event]).join(", ")}</p><p className="mt-2 text-xs text-zinc-500">Criado em {formatDateTime(item.createdAt)}{item.disabledAt ? ` · Desativado em ${formatDateTime(item.disabledAt)}` : ""}</p></div>
        <div className="flex gap-2">{item.active ? <Button variant="ghost" size="sm" disabled={busy} aria-label={`Desativar endpoint ${item.url}`} onClick={() => setDisable(item)}>Desativar</Button> : webhooksAvailable ? <Button variant="ghost" size="sm" disabled={busy || atLimit} aria-label={`Ativar endpoint ${item.url}`} onClick={() => void setActive(item, true)}>Ativar</Button> : null}<Button variant="ghost" size="sm" disabled={busy} aria-label={`Excluir endpoint ${item.url}`} onClick={() => setRemove(item)}>Excluir</Button></div>
      </li>)}</ul>}
    </section>

    <WebhookDeliveryHistory key={refresh} endpoints={endpoints?.items ?? []} canRetry={webhooksAvailable}/>

    <Dialog open={Boolean(disable)} onClose={() => setDisable(undefined)} onConfirm={() => { const selected = disable; setDisable(undefined); if (selected) void setActive(selected, false); }} title="Desativar este endpoint?" description="As entregas pendentes serão canceladas e não serão reenviadas automaticamente quando o endpoint for reativado." confirmLabel="Desativar endpoint"/>
    <Dialog open={Boolean(remove)} onClose={() => setRemove(undefined)} onConfirm={() => { const selected = remove; setRemove(undefined); if (selected) void destroy(selected); }} title="Excluir este endpoint?" description="O envio para esta URL é interrompido e o histórico de entregas deste endpoint é removido. Esta ação não pode ser desfeita." confirmLabel="Excluir endpoint"/>
    <Modal returnFocusRef={urlInput} open={Boolean(secret)} onClose={closeSecret} title="Guarde o segredo do webhook" description="Este valor aparece uma vez. Use-o no seu sistema para verificar a assinatura de cada entrega.">{secret ? <>
      <label className="block text-sm text-zinc-400">Segredo de assinatura<Input aria-label="Segredo do webhook criado" type={showSecret ? "text" : "password"} readOnly autoComplete="off" className="mt-3 font-mono text-xs" value={secret.secret} onFocus={event => event.currentTarget.select()}/></label>
      {copyError ? <p role="alert" className="mt-3 text-sm text-red-300">{copyError}</p> : null}
      <div className="mt-5 flex flex-wrap gap-3"><Button variant="secondary" onClick={() => setShowSecret(value => !value)}>{showSecret ? "Ocultar" : "Mostrar segredo"}</Button><Button onClick={() => void copy()}>{copied ? "Copiado" : "Copiar segredo"}</Button><Button variant="ghost" onClick={closeSecret}>Concluído</Button></div>
    </> : null}</Modal>
  </div>;
}
