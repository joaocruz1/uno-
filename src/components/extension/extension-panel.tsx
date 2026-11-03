"use client";

import { useEffect, useRef, useState } from "react";

import { Button, Dialog, EmptyState } from "@/components/ui";

type Connected = { id: string; name: string; prefix: string; userName: string; mine: boolean; lastUsedAt: string | null; createdAt: string };

function formatDate(value: string | null): string { return value ? new Date(value).toLocaleDateString("pt-BR") : "—"; }

export function ExtensionPanel() {
  const [items, setItems] = useState<Connected[]>();
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [revoke, setRevoke] = useState<Connected>();
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);

  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/dashboard/extension-tokens", { signal: abort.signal, cache: "no-store" });
        if (!response.ok) throw new Error();
        const body = await response.json() as { items: Connected[] };
        if (!abort.signal.aborted) { setItems(body.items); setError(undefined); }
      } catch { if (!abort.signal.aborted) setError("Não foi possível consultar os navegadores conectados."); }
    })();
    return () => abort.abort();
  }, [refresh]);

  const remove = async () => {
    if (!revoke || lock.current) return;
    lock.current = true; setBusy(true); setError(undefined);
    const selected = revoke; setRevoke(undefined);
    try {
      const response = await fetch(`/api/dashboard/extension-tokens/${selected.id}`, { method: "DELETE" });
      if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(typeof body.error?.message === "string" ? body.error.message : "Não foi possível desconectar."); }
      setRefresh(value => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível desconectar."); }
    finally { lock.current = false; setBusy(false); }
  };

  return <section className="mt-8">
    <div className="flex justify-between gap-3"><h2 className="font-heading text-xl font-semibold">Navegadores conectados</h2><Button variant="ghost" size="sm" disabled={busy} onClick={() => setRefresh(value => value + 1)}>Atualizar</Button></div>
    {error ? <p role="alert" className="mt-4 text-sm text-red-300">{error}</p> : null}
    {!items ? <p role="status" className="mt-5 text-[var(--color-muted)]">Consultando…</p>
      : !items.length ? <div className="mt-5"><EmptyState title="Nenhum navegador conectado" description="Instale a extensão e clique em Conectar no ícone da UNO."/></div>
      : <ul className="mt-5 divide-y divide-[var(--color-line)] rounded-xl border border-[var(--color-line)]">{items.map(item => <li key={item.id} className="flex flex-wrap items-center justify-between gap-4 p-5">
        <div className="min-w-0"><p className="truncate text-sm font-medium">{item.name}{item.mine ? "" : ` · ${item.userName}`}</p><p className="mt-2 font-mono text-xs text-[var(--color-muted)]">{item.prefix}…</p><p className="mt-2 text-xs text-[var(--color-muted)]">Conectado em {formatDate(item.createdAt)} · Último uso {formatDate(item.lastUsedAt)}</p></div>
        <Button variant="ghost" size="sm" disabled={busy} aria-label={`Desconectar ${item.name}`} onClick={() => setRevoke(item)}>Desconectar</Button>
      </li>)}</ul>}
    <Dialog open={Boolean(revoke)} onClose={() => setRevoke(undefined)} onConfirm={() => void remove()} title="Desconectar este navegador?" description="A extensão para de converter neste navegador até ser conectada de novo." confirmLabel="Desconectar"/>
  </section>;
}
