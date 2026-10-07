"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, ButtonLink, Input, Progress } from "@/components/ui";
import { ConversionResult } from "@/components/conversion/conversion-flow";
import { acceptedConversionSchema, conversionViewSchema, type ConversionView } from "@/lib/conversion-model";
import { outputSizeSchema } from "@/lib/label-size";

export function ConversionDetail({ id }: { id: string }) {
  const router = useRouter();
  const [conversion, setConversion] = useState<ConversionView>();
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [width, setWidth] = useState("100"); const [height, setHeight] = useState("250");
  const [busy, setBusy] = useState(false);
  const [retained, setRetained] = useState(false);
  const retryKey = useRef<{ key: string; fingerprint: string } | undefined>(undefined);
  const configuredId = useRef<string | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const response = await fetch(`/api/dashboard/conversions/${id}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error();
        const next = conversionViewSchema.parse(await response.json());
        if (controller.signal.aborted) return;
        setConversion(next); setError(undefined);
        setRetained(Boolean(next.artifactsExpireAt && new Date(next.artifactsExpireAt).getTime() > Date.now()));
        if (configuredId.current !== id) {
          configuredId.current = id;
          setWidth(String(next.size.widthMm)); setHeight(String(next.size.heightMm));
          retryKey.current = undefined;
        }
        if (next.status === "queued" || next.status === "processing") timer = setTimeout(() => void read(), 2000);
      } catch { if (!controller.signal.aborted) setError("Não foi possível consultar esta conversão."); }
    };
    void read(); return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [id, refresh]);
  const reprocess = async () => {
    if (busy || !conversion || conversion.id !== id) return;
    const parsed = outputSizeSchema.safeParse({ preset: "custom", widthMm: Number(width), heightMm: Number(height) });
    if (!parsed.success || parsed.data.preset !== "custom") { setError("Use largura entre 50 e 210 mm e altura entre 50 e 300 mm."); return; }
    const unchanged = conversion && conversion.size.widthMm === parsed.data.widthMm && conversion.size.heightMm === parsed.data.heightMm;
    const payload = unchanged ? {} : { size: parsed.data };
    const fingerprint = JSON.stringify(payload);
    if (!retryKey.current || retryKey.current.fingerprint !== fingerprint) retryKey.current = { key: crypto.randomUUID(), fingerprint };
    setBusy(true); setError(undefined);
    try {
      const response = await fetch(`/api/dashboard/conversions/${id}/reprocess`, { method: "POST", cache: "no-store", headers: { "content-type": "application/json", "idempotency-key": retryKey.current.key }, body: JSON.stringify(payload) });
      const body = await response.json();
      if (!response.ok) throw new Error(typeof body.error?.message === "string" ? body.error.message : "Não foi possível reprocessar.");
      const next = acceptedConversionSchema.parse(body); retryKey.current = undefined;
      router.push(`/dashboard/history/${next.id}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível reprocessar."); }
    finally { setBusy(false); }
  };
  if (conversion && conversion.id !== id) return <p role="status" className="text-zinc-400">Consultando conversão…</p>;
  return <div className="space-y-6"><ButtonLink variant="ghost" href="/dashboard/history">← Histórico</ButtonLink><div><h1 className="break-words font-heading text-2xl font-bold">{conversion?.originalFileName ?? "Detalhes da conversão"}</h1><p className="mt-2 break-all text-xs text-zinc-500">{id}</p></div>
    {error ? <div role="alert" className="rounded-xl border border-red-400/20 p-5 text-red-300">{error}<Button className="ml-3" size="sm" variant="ghost" onClick={() => setRefresh(value => value + 1)}>Atualizar</Button></div> : null}
    {!conversion && !error ? <p role="status" className="text-zinc-400">Consultando conversão…</p> : null}
    {conversion?.status === "completed" ? <ConversionResult conversion={conversion} onRefresh={() => setRefresh(value => value + 1)}/> : null}
    {conversion?.status === "failed" ? <section className="rounded-xl border border-red-400/20 p-6"><h2 className="font-heading text-xl font-semibold">Conversão não concluída</h2><p className="mt-3 text-red-200">{conversion.error?.message}</p><p className="mt-3 text-sm text-zinc-500">Nenhuma etiqueta confirmada na cota desta conversão.</p></section> : null}
    {conversion && ["queued", "processing"].includes(conversion.status) ? <section aria-live="polite" className="rounded-xl border border-white/10 p-6"><p className="text-zinc-300">{conversion.stage ?? "Na fila"}</p><Progress className="mt-5" value={conversion.progress} label="Progresso da conversão"/></section> : null}
    {conversion && ["completed", "failed"].includes(conversion.status) && retained ? <section className="rounded-xl border border-white/10 p-6"><h2 className="font-heading text-lg font-semibold">Reprocessar o original</h2><p className="mt-2 text-sm leading-6 text-zinc-400">Cria uma nova conversão. Uma etiqueta da cota será confirmada somente se concluir.</p><form className="mt-5 flex flex-wrap items-end gap-4" onSubmit={event => { event.preventDefault(); void reprocess(); }}><label className="w-36 text-sm text-zinc-400">Largura (mm)<Input className="mt-2" type="number" min={50} max={210} value={width} onChange={event => setWidth(event.target.value)}/></label><label className="w-36 text-sm text-zinc-400">Altura (mm)<Input className="mt-2" type="number" min={50} max={300} value={height} onChange={event => setHeight(event.target.value)}/></label><Button type="submit" disabled={busy}>{busy ? "Criando…" : "Reprocessar"}</Button></form></section> : null}
    {conversion?.events.length ? <section className="rounded-xl border border-white/10 p-6"><h2 className="font-heading text-lg font-semibold">Etapas registradas</h2><ol className="mt-4 space-y-3 text-sm text-zinc-400">{conversion.events.map((event, index) => <li key={`${event.createdAt}-${index}`} className="flex flex-wrap justify-between gap-2"><span>{event.stage} · {event.progress}%</span><time>{new Date(event.createdAt).toLocaleString("pt-BR")}</time></li>)}</ol></section> : null}
  </div>;
}
