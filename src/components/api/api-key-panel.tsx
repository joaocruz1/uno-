"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { z } from "zod";
import { Button, Dialog, EmptyState, Input, Modal } from "@/components/ui";
import { apiKeyCreatedSchema, apiKeyListSchema } from "@/lib/api-model";

type KeyList = z.infer<typeof apiKeyListSchema>;
type CreatedKey = z.infer<typeof apiKeyCreatedSchema>;
function formatDate(value: string | null): string { return value ? new Date(value).toLocaleDateString("pt-BR", { timeZone: "UTC" }) : "—"; }

export function ApiKeyPanel({ canManage, apiAvailable, rateLimit }: { canManage: boolean; apiAvailable: boolean; rateLimit: number }) {
  const [keys, setKeys] = useState<KeyList>();
  const [name, setName] = useState(""); const [secret, setSecret] = useState<CreatedKey>();
  const [showSecret, setShowSecret] = useState(false); const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string>();
  const [error, setError] = useState<string>(); const [refresh, setRefresh] = useState(0);
  const [snapshotTime, setSnapshotTime] = useState(0);
  const [busy, setBusy] = useState(false); const [revoke, setRevoke] = useState<KeyList["items"][number]>();
  const lock = useRef(false); const nameInput = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!canManage) return;
    const abort = new AbortController();
    void (async () => {
      try { const response = await fetch("/api/dashboard/api-keys", { signal: abort.signal, cache: "no-store" }); if (!response.ok) throw new Error(); const body = apiKeyListSchema.parse(await response.json()); if (!abort.signal.aborted) { setKeys(body); setSnapshotTime(Date.now()); setError(undefined); } }
      catch { if (!abort.signal.aborted) setError("Não foi possível consultar as chaves. Tente atualizar."); }
    })(); return () => abort.abort();
  }, [canManage, refresh]);

  const create = async () => {
    if (!canManage || !apiAvailable || lock.current || !name.trim()) return;
    lock.current = true; setBusy(true); setError(undefined);
    try {
      const response = await fetch("/api/dashboard/api-keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: name.trim() }) });
      const body = await response.json();
      if (!response.ok) throw new Error(typeof body.error?.message === "string" ? body.error.message : "Não foi possível criar a chave.");
      const created = apiKeyCreatedSchema.parse(body);
      setSecret(created); setShowSecret(false); setCopied(false); setCopyError(undefined); setName(""); setRefresh(value => value + 1);
    } catch (cause) { setError(cause instanceof z.ZodError ? "Não foi possível confirmar a criação. Atualize a lista e revogue a chave se não recebeu seu valor." : cause instanceof Error ? cause.message : "Não foi possível criar a chave."); }
    finally { lock.current = false; setBusy(false); }
  };
  const remove = async () => {
    if (!revoke || lock.current || !canManage) return;
    lock.current = true; setBusy(true); setError(undefined);
    const selected = revoke; setRevoke(undefined);
    try { const response = await fetch(`/api/dashboard/api-keys/${selected.id}`, { method: "DELETE" }); const body = response.status === 204 ? {} : await response.json(); if (!response.ok) throw new Error(typeof body.error?.message === "string" ? body.error.message : "Não foi possível revogar a chave."); setRefresh(value => value + 1); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível revogar a chave."); }
    finally { lock.current = false; setBusy(false); }
  };
  const copy = async () => {
    if (!secret) return;
    try { await navigator.clipboard.writeText(secret.key); setCopied(true); setCopyError(undefined); }
    catch { setCopyError("Selecione e copie o valor da chave manualmente."); }
  };
  if (!canManage) return <section className="mt-8 rounded-2xl border border-white/10 bg-[#080808] p-6"><p className="text-sm text-zinc-400">O proprietário ou administrador da organização gerencia as chaves de API.</p><Link href="/docs" className="mt-4 inline-block text-sm text-uno-red">Consultar documentação</Link></section>;
  return <div className="mt-8 space-y-8">
    <section className="rounded-2xl border border-white/10 bg-[#080808] p-6"><div className="flex flex-wrap justify-between gap-4"><div><h2 className="font-heading text-xl font-semibold">Chaves da organização</h2><p className="mt-2 text-sm text-zinc-400">{apiAvailable ? `${rateLimit} requisições por minuto por organização.` : "A API está disponível nos planos Pro e Business. Você pode revogar chaves existentes."}</p></div><Link href={apiAvailable ? "/docs" : "/dashboard/billing"} className="text-sm text-uno-red underline">{apiAvailable ? "Documentação da API" : "Consultar planos"}</Link></div>
      {apiAvailable ? <form className="mt-6 flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); void create(); }}><label className="min-w-0 flex-1 text-sm text-zinc-400">Nome da integração<Input ref={nameInput} className="mt-2" value={name} maxLength={80} required placeholder="ERP da expedição" disabled={busy} onChange={event => setName(event.target.value)}/></label><Button type="submit" disabled={busy || !name.trim()}>{busy ? "Aguarde…" : "Criar chave"}</Button></form> : null}
      {error ? <p role="alert" className="mt-5 text-sm text-red-300">{error}</p> : null}
    </section>
    <section><div className="flex justify-between gap-3"><h2 className="font-heading text-xl font-semibold">Suas chaves</h2><Button variant="ghost" size="sm" disabled={busy} onClick={() => setRefresh(value => value + 1)}>Atualizar</Button></div>{!keys ? <p role="status" className="mt-5 text-zinc-400">Consultando chaves…</p> : !keys.items.length ? <div className="mt-5"><EmptyState title="Nenhuma chave criada" description="Crie uma chave para conectar seu ERP à UNO."/></div> : <ul className="mt-5 divide-y divide-white/10 rounded-xl border border-white/10">{keys.items.map(item => <li key={item.id} className="flex flex-wrap items-center justify-between gap-4 p-5"><div className="min-w-0"><p className="truncate text-sm font-medium">{item.name}</p><p className="mt-2 font-mono text-xs text-zinc-500">{item.prefix}… · {item.revokedAt ? "Revogada" : item.expiresAt && new Date(item.expiresAt).getTime() <= snapshotTime ? "Expirada" : "Ativa"}</p><p className="mt-2 text-xs text-zinc-500">Criada em {formatDate(item.createdAt)} · Último uso {formatDate(item.lastUsedAt)}{item.expiresAt ? ` · Expira em ${formatDate(item.expiresAt)}` : ""}</p></div>{!item.revokedAt ? <Button variant="ghost" size="sm" disabled={busy} aria-label={`Revogar chave ${item.name}`} onClick={event => { event.currentTarget.focus(); setRevoke(item); }}>Revogar</Button> : null}</li>)}</ul>}</section>
    <Dialog open={Boolean(revoke)} onClose={() => setRevoke(undefined)} onConfirm={() => void remove()} title="Revogar esta chave?" description="O ERP perderá o acesso nas próximas requisições. Conversões já aceitas continuam o processamento." confirmLabel="Revogar chave"/>
    <Modal returnFocusRef={nameInput} open={Boolean(secret)} onClose={() => { setSecret(undefined); setShowSecret(false); setCopied(false); }} title="Guarde sua chave" description="Este valor aparece uma vez. Armazene-o no cofre de segredos do ERP.">{secret ? <><label className="block text-sm text-zinc-400">Chave de API<Input aria-label="Chave de API criada" type={showSecret ? "text" : "password"} readOnly autoComplete="off" className="mt-3 font-mono text-xs" value={secret.key} onFocus={event => event.currentTarget.select()}/></label>{copyError ? <p role="alert" className="mt-3 text-sm text-red-300">{copyError}</p> : null}<div className="mt-5 flex flex-wrap gap-3"><Button variant="secondary" onClick={() => setShowSecret(value => !value)}>{showSecret ? "Ocultar" : "Mostrar chave"}</Button><Button onClick={() => void copy()}>{copied ? "Copiada" : "Copiar chave"}</Button><Button variant="ghost" onClick={() => { setSecret(undefined); setShowSecret(false); setCopied(false); }}>Concluído</Button></div></> : null}</Modal>
  </div>;
}
