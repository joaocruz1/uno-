"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Button, ButtonLink, Progress } from "@/components/ui";
import { batchDetailSchema, batchItemsPageSchema } from "@/lib/batch-model";

type Batch = z.infer<typeof batchDetailSchema>;
type Items = z.infer<typeof batchItemsPageSchema>;
const labels: Record<string, string> = { queued: "Na fila", processing: "Processando", packaging: "Preparando o ZIP", completed: "Concluído", failed: "Falhou" };

export function BatchDetail({ id }: { id: string }) {
  const [batch, setBatch] = useState<Batch>(); const [items, setItems] = useState<Items>();
  const [cursor, setCursor] = useState<string>(); const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState<string>(); const [downloading, setDownloading] = useState(false);
  const loadedId = useRef<string | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const responses = await Promise.all([fetch(`/api/dashboard/batches/${id}`, { cache: "no-store", signal: controller.signal }), fetch(`/api/dashboard/batches/${id}/items${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, { cache: "no-store", signal: controller.signal })]);
        if (responses.some(response => !response.ok)) throw new Error();
        const [detail, page] = await Promise.all(responses.map(response => response.json()));
        if (controller.signal.aborted) return;
        const next = batchDetailSchema.parse(detail); setBatch(next); setItems(batchItemsPageSchema.parse(page)); loadedId.current = id; setError(undefined);
        if (["queued", "processing"].includes(next.status)) timer = setTimeout(() => void read(), 2000);
      } catch { if (!controller.signal.aborted) setError("Não foi possível consultar o lote. O processamento continua."); }
    };
    void read(); return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [id, cursor, refresh]);
  const download = async () => {
    if (downloading || loadedId.current !== id) return;
    setDownloading(true); setError(undefined);
    try {
      const response = await fetch(`/api/dashboard/batches/${id}/download`, { cache: "no-store" }); const body = await response.json();
      if (!response.ok) throw new Error(typeof body.error?.message === "string" ? body.error.message : "Não foi possível baixar o ZIP.");
      const archive = z.object({ url: z.url().refine(value => ["http:", "https:"].includes(new URL(value).protocol)), expiresAt: z.iso.datetime({ offset: true }) }).parse(body);
      const anchor = document.createElement("a"); anchor.href = archive.url; anchor.download = `uno-lote-${id}.zip`; anchor.rel = "noopener noreferrer"; anchor.target = "_blank"; document.body.appendChild(anchor); anchor.click(); anchor.remove();
    } catch (cause) { setError(cause instanceof Error && !(cause instanceof z.ZodError) ? cause.message : "Não foi possível baixar o ZIP."); }
    finally { setDownloading(false); }
  };
  const current = batch?.id === id ? batch : undefined;
  return <div className="space-y-6"><ButtonLink variant="ghost" href="/dashboard/batches">← Lotes</ButtonLink><h1 className="font-heading text-3xl font-bold">{current ? `Lote de ${current.counts.total} etiquetas` : "Detalhes do lote"}</h1>{error ? <p role="alert" className="rounded-xl border border-red-400/20 p-5 text-red-300">{error}</p> : null}
    {!current ? <p role="status" className="text-zinc-400">Consultando lote…</p> : <><section aria-live="polite" className="rounded-2xl border border-white/10 bg-[#080808] p-6"><h2 className="font-heading text-xl font-semibold">{labels[current.phase]}</h2><Progress className="mt-5" value={current.progress} label="Progresso do lote"/><div className="mt-5 flex flex-wrap gap-5 text-sm"><p className="text-emerald-300">{current.counts.completed} aprovadas</p><p className="text-red-300">{current.counts.failed} falhas</p><p className="text-zinc-400">{current.counts.queued + current.counts.processing} em andamento</p></div>{current.archive.error ? <p className="mt-4 text-sm text-red-300">{current.archive.error.message} Os resultados individuais continuam disponíveis durante a retenção.</p> : null}<div className="mt-5 flex flex-wrap gap-3">{current.archive.status === "ready" ? <Button onClick={() => void download()} disabled={downloading}>{downloading ? "Obtendo link…" : "Baixar ZIP"}</Button> : null}<Button variant="secondary" onClick={() => setRefresh(value => value + 1)}>Atualizar</Button></div><p className="mt-4 text-xs leading-5 text-zinc-500">O ZIP inclui somente etiquetas aprovadas. Arquivos privados, sujeitos à retenção do plano.</p></section>
    {items ? <section className="rounded-xl border border-white/10"><h2 className="border-b border-white/10 p-5 font-heading text-lg font-semibold">Arquivos do lote</h2><ul className="divide-y divide-white/10">{items.items.map(item => <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 p-5"><div className="min-w-0"><p className="max-w-72 truncate text-sm text-zinc-200">{item.originalFileName ?? "Arquivo PDF"}</p><p className="mt-1 text-xs text-zinc-500">{labels[item.status]}{item.status === "processing" ? ` · ${item.progress}%` : ""}</p>{item.error ? <p className="mt-2 max-w-lg text-xs text-red-300">{item.error.message}</p> : null}</div><Link className="text-sm font-medium text-uno-red underline underline-offset-4" href={`/dashboard/history/${item.id}`}>Ver conversão</Link></li>)}</ul><div className="flex justify-between border-t border-white/10 p-4"><Button variant="ghost" size="sm" disabled={!cursor} onClick={() => setCursor(undefined)}>Voltar ao início</Button><Button variant="secondary" size="sm" disabled={!items.nextCursor} onClick={() => setCursor(items.nextCursor ?? undefined)}>Próxima página</Button></div></section> : null}</>}
  </div>;
}
