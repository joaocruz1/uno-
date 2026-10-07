"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { z } from "zod";
import { Button, Dialog, EmptyState, Input, Progress } from "@/components/ui";
import { batchListSchema, batchUploadSessionSchema } from "@/lib/batch-model";
import { outputSizeSchema } from "@/lib/label-size";

type UploadSession = z.infer<typeof batchUploadSessionSchema>;
type BatchList = z.infer<typeof batchListSchema>;
const statusLabels: Record<string, string> = { queued: "Na fila", processing: "Processando", completed: "Concluído", failed: "Falhou" };

async function jsonRequest(path: string, options: RequestInit, signal?: AbortSignal): Promise<unknown> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(path, { ...options, signal, cache: "no-store" });
    const body = await response.json();
    if (response.status === 429 && attempt < 5) {
      const seconds = Math.min(120, Math.max(1, Number(response.headers.get("retry-after")) || 60));
      await wait(seconds * 1000, signal); continue;
    }
    if (!response.ok) throw new Error(typeof body.error?.message === "string" ? body.error.message : "Não foi possível concluir esta etapa.");
    return body;
  }
  throw new Error("Aguarde antes de tentar novamente.");
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(new DOMException("Cancelado", "AbortError")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, milliseconds);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

function uploadFile(file: File, signed: { uploadUrl: string; headers: Record<string, string> }, signal: AbortSignal, progress: (value: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const cleanup = () => signal.removeEventListener("abort", abort);
    xhr.open("PUT", signed.uploadUrl); xhr.timeout = 240_000;
    for (const [name, value] of Object.entries(signed.headers)) if (name.toLowerCase() !== "content-length") xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = event => { if (event.lengthComputable) progress(Math.round(event.loaded / event.total * 100)); };
    xhr.onload = () => { cleanup(); if (xhr.status >= 200 && xhr.status < 300) resolve(); else reject(new Error("O envio não concluiu. Tente preparar o arquivo novamente.")); };
    xhr.onerror = xhr.ontimeout = () => { cleanup(); reject(new Error("O envio falhou. Confira sua conexão e tente novamente.")); };
    xhr.onabort = () => { cleanup(); reject(new DOMException("Upload cancelado", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { cleanup(); reject(new DOMException("Upload cancelado", "AbortError")); return; }
    xhr.send(file);
  });
}

export function BatchPanel({ batchLimit, maxFileMB }: { batchLimit: number; maxFileMB: number }) {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [session, setSession] = useState<UploadSession>();
  const [width, setWidth] = useState("100"); const [height, setHeight] = useState("150");
  const [list, setList] = useState<BatchList>(); const [listError, setListError] = useState<string>();
  const [cursor, setCursor] = useState<string>(); const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string>();
  const [uploading, setUploading] = useState(false);
  const [activeItem, setActiveItem] = useState(0); const [uploadProgress, setUploadProgress] = useState(0);
  const [preparationStage, setPreparationStage] = useState("Enviando");
  const [confirm, setConfirm] = useState(false);
  const controller = useRef<AbortController | undefined>(undefined);
  const preparing = useRef(false); const accepting = useRef(false);
  const operationKey = useRef<string | undefined>(undefined);
  const fileMap = useRef(new Map<string, File>());
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      try { const body = await jsonRequest(`/api/dashboard/batches${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, {}, abort.signal); if (!abort.signal.aborted) { setList(batchListSchema.parse(body)); setListError(undefined); } }
      catch { if (!abort.signal.aborted) setListError("Não foi possível consultar os lotes."); }
    })();
    return () => abort.abort();
  }, [cursor, refresh]);

  const prepare = async () => {
    if (preparing.current || accepting.current || !files.length) return;
    const size = outputSizeSchema.safeParse({ preset: "custom", widthMm: Number(width), heightMm: Number(height) });
    if (!size.success) { setError("Use largura entre 50 e 210 mm e altura entre 50 e 300 mm."); return; }
    preparing.current = true; setBusy(true); setUploading(true); setError(undefined); setUploadProgress(0);
    const abort = new AbortController(); controller.current = abort;
    try {
      let staged = session;
      if (!staged) {
        fileMap.current.clear();
        const manifest = files.map(file => { const clientItemId = crypto.randomUUID(); fileMap.current.set(clientItemId, file); return { clientItemId, originalFileName: file.name, contentLength: file.size }; });
        const body = await jsonRequest("/api/dashboard/batch-uploads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: manifest, size: size.data }) }, abort.signal);
        staged = batchUploadSessionSchema.parse(body); setSession(staged); operationKey.current = crypto.randomUUID();
      } else {
        staged = batchUploadSessionSchema.parse(await jsonRequest(`/api/dashboard/batch-uploads/${staged.id}`, {}, abort.signal)); setSession(staged);
      }
      for (let index = 0; index < staged.items.length; index += 1) {
        let item = staged.items[index];
        while (item.status === "preparing") {
          setActiveItem(index + 1); setUploadProgress(100); setPreparationStage("Validando");
          await wait(2000, abort.signal);
          staged = batchUploadSessionSchema.parse(await jsonRequest(`/api/dashboard/batch-uploads/${staged.id}`, {}, abort.signal)); setSession(staged);
          const currentItem = staged.items.find(entry => entry.id === item.id);
          if (!currentItem) throw new Error("Não foi possível confirmar o arquivo preparado.");
          item = currentItem;
        }
        if (item.status === "ready") continue;
        setActiveItem(index + 1); setUploadProgress(0); setPreparationStage("Enviando");
        const file = fileMap.current.get(item.clientItemId);
        if (!file) throw new Error("Selecione os arquivos novamente para preparar um novo lote.");
        const signed = z.object({ uploadUrl: z.url(), headers: z.record(z.string(), z.string()) }).parse(await jsonRequest(`/api/dashboard/batch-uploads/${staged.id}/items/${item.id}/upload`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, abort.signal));
        await uploadFile(file, signed, abort.signal, setUploadProgress);
        setPreparationStage("Validando");
        await jsonRequest(`/api/dashboard/batch-uploads/${staged.id}/items/${item.id}/complete`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, abort.signal);
        staged = batchUploadSessionSchema.parse(await jsonRequest(`/api/dashboard/batch-uploads/${staged.id}`, {}, abort.signal)); setSession(staged);
        let preparedItem = staged.items.find(entry => entry.id === item.id);
        if (!preparedItem) throw new Error("Não foi possível confirmar o arquivo preparado.");
        if (preparedItem.status === "failed") throw new Error(preparedItem.error?.message ?? "Este arquivo não pôde ser preparado.");
        while (preparedItem.status === "preparing") {
          await wait(2000, abort.signal);
          staged = batchUploadSessionSchema.parse(await jsonRequest(`/api/dashboard/batch-uploads/${staged.id}`, {}, abort.signal)); setSession(staged);
          preparedItem = staged.items.find(entry => entry.id === item.id);
          if (!preparedItem) throw new Error("Não foi possível confirmar o arquivo preparado.");
          if (preparedItem.status === "failed") throw new Error(preparedItem.error?.message ?? "Este arquivo não pôde ser preparado.");
        }
      }
      setActiveItem(staged.items.length); setUploadProgress(100);
    } catch (cause) { setError(cause instanceof DOMException && cause.name === "AbortError" ? "Preparação pausada. Você pode tentar novamente." : cause instanceof Error ? cause.message : "Não foi possível preparar os arquivos."); }
    finally { preparing.current = false; setBusy(false); setUploading(false); }
  };
  const accept = async () => {
    if (!session || accepting.current || preparing.current) return;
    accepting.current = true; setBusy(true); setConfirm(false); setError(undefined);
    operationKey.current ??= crypto.randomUUID();
    try {
      const response = await jsonRequest("/api/dashboard/batches", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": operationKey.current }, body: JSON.stringify({ uploadSessionId: session.id }) });
      const next = z.object({ id: z.uuid() }).parse(response); router.push(`/dashboard/batches/${next.id}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível aceitar o lote."); }
    finally { accepting.current = false; setBusy(false); }
  };
  const allReady = session?.items.every(item => item.status === "ready");
  return <div className="mt-8 space-y-8"><section className="rounded-2xl border border-white/10 bg-[#080808] p-5 sm:p-7"><h2 className="font-heading text-xl font-semibold">Preparar um lote</h2><p className="mt-2 text-sm text-zinc-400">Até {batchLimit} arquivos · {maxFileMB} MB por PDF. A cota será reservada ao confirmar o lote.</p>
    <div className="mt-5 flex flex-wrap gap-4"><label className="w-36 text-sm text-zinc-400">Largura (mm)<Input className="mt-2" type="number" min={50} max={210} value={width} disabled={Boolean(session) || busy} onChange={event => setWidth(event.target.value)}/></label><label className="w-36 text-sm text-zinc-400">Altura (mm)<Input className="mt-2" type="number" min={50} max={300} value={height} disabled={Boolean(session) || busy} onChange={event => setHeight(event.target.value)}/></label></div>
    <label className="mt-5 block rounded-xl border border-dashed border-white/15 p-5 text-sm text-zinc-400">Selecionar PDFs<input aria-label="Selecionar PDFs do lote" type="file" multiple accept="application/pdf,.pdf" disabled={busy || Boolean(session)} className="mt-3 block max-w-full text-sm file:mr-4 file:rounded-full file:border-0 file:bg-uno-red file:px-4 file:py-2 file:font-semibold file:text-white" onChange={event => { const chosen = Array.from(event.target.files ?? []); if (chosen.length > batchLimit) { setError(`Seu plano aceita até ${batchLimit} arquivos por lote.`); setFiles([]); return; } if (chosen.some(file => file.size < 1 || file.size > maxFileMB * 1024 * 1024)) { setError(`Cada PDF deve ter até ${maxFileMB} MB.`); setFiles([]); return; } setFiles(chosen); setError(undefined); }}/></label>
    {files.length ? <p className="mt-4 text-sm text-zinc-300">{files.length} {files.length === 1 ? "arquivo selecionado" : "arquivos selecionados"}</p> : null}
    {busy && uploading ? <div aria-live="polite" className="mt-5"><p className="mb-3 text-sm text-zinc-400">{preparationStage} arquivo {activeItem} de {files.length}</p><Progress value={uploadProgress} label="Envio do arquivo atual"/></div> : null}
    {error ? <p role="alert" className="mt-5 text-sm leading-6 text-red-300">{error}</p> : null}
    {session ? <ul className="mt-5 max-h-64 space-y-2 overflow-y-auto text-sm">{session.items.map(item => <li key={item.id} className="flex justify-between gap-4"><span className="min-w-0 truncate text-zinc-400">{item.originalFileName ?? "Arquivo PDF"}</span><span className={item.status === "ready" ? "text-emerald-300" : "text-zinc-500"}>{({ pending: "Aguardando", uploading: "Enviando", preparing: "Validando", ready: "Preparado", failed: "Falhou" })[item.status]}</span></li>)}</ul> : null}
    <div className="mt-6 flex flex-wrap gap-3">{allReady ? <Button disabled={busy} onClick={event => { event.currentTarget.focus(); setConfirm(true); }}>Confirmar lote</Button> : <Button disabled={busy || !files.length} onClick={() => void prepare()}>{session ? "Retomar preparação" : "Preparar arquivos"}</Button>}{busy && uploading ? <Button variant="secondary" onClick={() => controller.current?.abort()}>Pausar</Button> : null}{session && !busy ? <Button variant="ghost" onClick={() => { setSession(undefined); setFiles([]); setError(undefined); operationKey.current = undefined; }}>Começar outro lote</Button> : null}</div>
    <Dialog open={confirm} onClose={() => setConfirm(false)} onConfirm={() => void accept()} title="Confirmar este lote?" description={`${files.length} etiquetas serão reservadas. Somente conversões concluídas consomem a cota.`} confirmLabel="Processar lote"/>
  </section><section><div className="flex items-center justify-between gap-4"><h2 className="font-heading text-xl font-semibold">Seus lotes</h2><Button size="sm" variant="ghost" onClick={() => setRefresh(value => value + 1)}>Atualizar</Button></div>{listError ? <p role="alert" className="mt-5 text-red-300">{listError}</p> : !list ? <p role="status" className="mt-5 text-zinc-400">Consultando lotes…</p> : list.items.length ? <div className="mt-5 divide-y divide-white/10 rounded-xl border border-white/10">{list.items.map(batch => <Link key={batch.id} href={`/dashboard/batches/${batch.id}`} className="flex flex-wrap justify-between gap-3 p-5 hover:bg-white/[.025]"><div><p className="text-sm font-medium">{batch.counts.total} etiquetas · {statusLabels[batch.status]}</p><p className="mt-1 text-xs text-zinc-500">{new Date(batch.createdAt).toLocaleString("pt-BR")}</p></div><p className="text-sm text-zinc-400">{batch.counts.completed} aprovadas · {batch.counts.failed} falhas</p></Link>)}</div> : <div className="mt-5"><EmptyState title="Nenhum lote ainda" description="Selecione PDFs acima para começar."/></div>}{list ? <div className="mt-4 flex justify-between"><Button size="sm" variant="ghost" disabled={!cursor} onClick={() => setCursor(undefined)}>Voltar ao início</Button><Button size="sm" variant="secondary" disabled={!list.nextCursor} onClick={() => setCursor(list.nextCursor ?? undefined)}>Próxima página</Button></div> : null}</section></div>;
}
