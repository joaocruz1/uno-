"use client";

import Link from "next/link";
import { ArrowRight, Check, Download, FileUp, LoaderCircle, Plus, RotateCcw, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { ChannelMark } from "@/components/marketplace-logos";
import { PdfCanvasPreview } from "@/components/conversion/pdf-preview";

const MAX_BYTES = 5 * 1_024 * 1_024;
type Phase = "checking" | "idle" | "processing" | "done" | "used" | "error";
type Channel = "mercado-livre" | "shopee" | "tiktok";

const TABS: { id: Channel; name: string; drop: string; result: string; hasNfe?: boolean }[] = [
  { id: "mercado-livre", name: "Mercado Livre", drop: "Arraste o PDF de 2 páginas (etiqueta + DANFE).", result: "Etiqueta unificada, pronta pra 10×15." },
  { id: "shopee", name: "Shopee", drop: "Arraste o PDF de etiquetas da Shopee.", result: "Cada etiqueta conferida, num PDF 10×15." },
  { id: "tiktok", name: "TikTok Shop", drop: "Arraste o PDF de etiquetas do TikTok.", result: "Cada etiqueta seguida da sua NF-e.", hasNfe: true },
];

/** Landing demo: one anonymous conversion for any of the three marketplaces,
 * rendered and downloadable on the spot. Nothing is stored. */
export function TrialStudio() {
  const fileInput = useRef<HTMLInputElement>(null);
  const nfeInput = useRef<HTMLInputElement>(null);
  const [channel, setChannel] = useState<Channel>("mercado-livre");
  const [phase, setPhase] = useState<Phase>("checking");
  const [dragging, setDragging] = useState(false);
  const [nfe, setNfe] = useState<File>();
  const [message, setMessage] = useState<string>();
  const [pdf, setPdf] = useState<Uint8Array>();
  const [href, setHref] = useState<string>();
  const [pages, setPages] = useState(0);

  const tab = TABS.find((entry) => entry.id === channel)!;

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/public/trial", { cache: "no-store", signal: controller.signal });
        const body = await response.json() as { available?: boolean };
        if (!controller.signal.aborted) setPhase(response.ok && body.available === false ? "used" : "idle");
      } catch {
        if (!controller.signal.aborted) setPhase("idle");
      }
    })();
    return () => controller.abort();
  }, []);

  useEffect(() => () => { if (href) URL.revokeObjectURL(href); }, [href]);

  const selectChannel = (next: Channel) => {
    if (next === channel) return;
    setChannel(next);
    setNfe(undefined);
    setMessage(undefined);
    setPdf(undefined);
    if (href) { URL.revokeObjectURL(href); setHref(undefined); }
    setPhase((current) => (current === "used" ? "used" : "idle"));
  };

  const convert = useCallback(async (file: File | undefined) => {
    if (!file || phase === "processing" || phase === "done" || phase === "used") return;
    if (file.type && file.type !== "application/pdf") { setPhase("error"); setMessage("Selecione um arquivo PDF."); return; }
    if (file.size > MAX_BYTES) { setPhase("error"); setMessage("O teste aceita PDFs de até 5 MB."); return; }
    setPhase("processing");
    setMessage(undefined);
    try {
      const form = new FormData();
      form.append("marketplace", channel);
      form.append("file", file, "etiqueta.pdf");
      if (channel === "tiktok" && nfe) form.append("nfe", nfe, "nfe.pdf");
      const response = await fetch("/api/public/trial", { method: "POST", body: form, cache: "no-store" });
      if (!response.ok) {
        const body = await response.json().catch(() => undefined) as { error?: { code?: string; message?: string } } | undefined;
        if (body?.error?.code === "trial_used") { setPhase("used"); return; }
        setPhase("error");
        setMessage(body?.error?.message ?? "Não foi possível processar este PDF. Tente novamente.");
        return;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      setPdf(bytes);
      setPages(Number(response.headers.get("x-uno-pages") ?? 0));
      setHref(URL.createObjectURL(new Blob([bytes], { type: "application/pdf" })));
      setPhase("done");
    } catch {
      setPhase("error");
      setMessage("Sem conexão com o servidor. Tente novamente.");
    }
  }, [phase, channel, nfe]);

  const interactive = phase === "idle" || phase === "error";

  return (
    <div className="trial-frame relative mx-auto w-full max-w-3xl">
      <span className="corner-mark left-0 top-0" aria-hidden="true" />
      <span className="corner-mark right-0 top-0 rotate-90" aria-hidden="true" />
      <span className="corner-mark bottom-0 right-0 rotate-180" aria-hidden="true" />
      <span className="corner-mark bottom-0 left-0 -rotate-90" aria-hidden="true" />
      <div className={`relative overflow-hidden border bg-[#050505] p-5 transition-[border-color,box-shadow] duration-300 sm:p-7 ${dragging ? "border-uno-red shadow-[0_0_0_1px_rgba(239,35,60,.6),0_30px_120px_rgba(239,35,60,.35)]" : "border-white/10 shadow-[0_30px_100px_rgba(239,35,60,.12)]"}`}>
        <div className="grid-pan absolute inset-0" aria-hidden="true" />

        <div className="relative flex items-center justify-between text-[10px] font-medium text-zinc-500 sm:text-[11px]">
          <span className="flex items-center gap-2"><span className="live-dot" aria-hidden="true" />TESTE GRÁTIS · 1 ETIQUETA</span>
          <span>SEM CADASTRO</span>
        </div>

        <div className="relative mt-4 flex flex-wrap gap-2" role="tablist" aria-label="Marketplace">
          {TABS.map((entry) => {
            const selected = entry.id === channel;
            return (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => selectChannel(entry.id)}
                className={`flex items-center gap-2 rounded-full border px-3.5 py-2 text-xs font-semibold transition-colors ${selected ? "border-uno-red bg-uno-red/15 text-white" : "border-white/12 text-zinc-400 hover:border-white/30 hover:text-zinc-200"}`}
              >
                <ChannelMark id={entry.id} size={18} />
                {entry.name}
              </button>
            );
          })}
        </div>

        {phase === "done" && pdf && href ? (
          <div className="relative mt-6 grid items-center gap-6 sm:grid-cols-[minmax(0,200px)_1fr]">
            <div className="relative mx-auto w-full max-w-[200px]">
              <div className="absolute -inset-3 bg-uno-red/20 blur-2xl" aria-hidden="true" />
              <PdfCanvasPreview data={pdf} title="Resultado" expectedPages="first" className="relative aspect-[2/3] overflow-hidden bg-white shadow-[0_18px_60px_rgba(0,0,0,.6)]" />
            </div>
            <div>
              <p className="inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-xs text-emerald-300"><Check size={13} />Conferido</p>
              <h3 className="mt-4 font-heading text-2xl font-extrabold tracking-[-.03em] text-white">{tab.result}</h3>
              <p className="mt-3 text-sm leading-6 text-zinc-400">{pages > 0 ? `${pages} página${pages === 1 ? "" : "s"} · ` : ""}Processado em memória, sem ficar guardado. Este era o seu teste gratuito.</p>
              <a href={href} download="uno-etiqueta.pdf" className="mt-6 inline-flex h-12 w-full items-center justify-center gap-2 bg-uno-red px-6 text-sm font-semibold text-white transition hover:bg-[#ff3b52] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white sm:w-auto"><Download size={17} />Baixar PDF</a>
              <Link href="/register" className="mt-4 flex items-center gap-2 text-sm font-semibold text-zinc-200 hover:text-white">Criar conta e converter lotes inteiros <ArrowRight size={15} /></Link>
            </div>
          </div>
        ) : phase === "used" ? (
          <div className="relative mt-14 pb-6 text-center">
            <span className="mx-auto grid size-14 place-items-center rounded-full border border-uno-red/30 bg-uno-red/10 text-uno-red"><Check size={24} /></span>
            <h3 className="mt-6 font-heading text-2xl font-extrabold tracking-[-.03em] text-white">Você já usou o teste gratuito.</h3>
            <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-zinc-400">Crie sua conta para continuar: o plano Free inclui 10 etiquetas por mês, com histórico e download a qualquer momento.</p>
            <Link href="/register" className="mt-7 inline-flex h-12 items-center justify-center gap-2 bg-uno-red px-7 text-sm font-semibold text-white transition hover:bg-[#ff3b52] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">Criar conta grátis <ArrowRight size={17} /></Link>
          </div>
        ) : (
          <div className="relative mt-5">
            <div
              className={`grid min-h-[240px] place-items-center rounded-lg border border-dashed p-6 text-center transition-colors ${dragging ? "border-uno-red bg-uno-red/10" : "border-white/15 bg-black/40"}`}
              onDragOver={(event) => { if (interactive) { event.preventDefault(); setDragging(true); } }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => { event.preventDefault(); setDragging(false); if (interactive) void convert(event.dataTransfer.files[0]); }}
            >
              <div>
                <span className={`mx-auto grid size-16 place-items-center rounded-full border ${dragging ? "border-uno-red bg-uno-red/20 text-white" : "border-white/20 bg-black/70 text-uno-red"}`}>
                  {phase === "processing" ? <LoaderCircle size={26} className="animate-spin motion-reduce:animate-none" /> : <FileUp size={26} />}
                </span>
                {phase === "processing" ? (
                  <p role="status" className="mt-5 font-heading text-xl font-bold text-white">Processando sua etiqueta…</p>
                ) : (
                  <>
                    <h3 className="mt-5 font-heading text-2xl font-extrabold tracking-[-.03em] text-white">{dragging ? "Pode soltar." : "Jogue sua etiqueta aqui."}</h3>
                    <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-zinc-400">{tab.drop}</p>
                    <button type="button" disabled={phase === "checking"} onClick={() => fileInput.current?.click()} className="mt-5 inline-flex h-11 items-center justify-center gap-2 border border-white/15 bg-white px-6 text-sm font-semibold text-black transition hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-uno-red disabled:opacity-60">Selecionar PDF</button>
                  </>
                )}
              </div>
            </div>

            {tab.hasNfe && phase !== "processing" ? (
              <div className="mt-3 flex items-center justify-center gap-2 text-xs text-zinc-500">
                {nfe ? (
                  <span className="inline-flex items-center gap-2 rounded-full border border-white/12 px-3 py-1.5 text-zinc-300">
                    NF-e: {nfe.name.length > 24 ? `${nfe.name.slice(0, 24)}…` : nfe.name}
                    <button type="button" onClick={() => setNfe(undefined)} className="text-zinc-500 hover:text-uno-red" aria-label="Remover NF-e"><X size={13} /></button>
                  </span>
                ) : (
                  <button type="button" onClick={() => nfeInput.current?.click()} className="inline-flex items-center gap-1.5 rounded-full border border-white/12 px-3 py-1.5 text-zinc-400 transition-colors hover:border-white/30 hover:text-zinc-200"><Plus size={13} />Adicionar NF-e (opcional)</button>
                )}
              </div>
            ) : null}

            {phase === "error" && message ? <p role="alert" className="mx-auto mt-4 flex max-w-sm items-center justify-center gap-2 text-center text-sm text-red-300"><RotateCcw size={14} />{message}</p> : null}
          </div>
        )}

        <input ref={fileInput} type="file" accept="application/pdf,.pdf" className="sr-only" aria-label="Selecionar PDF para o teste" tabIndex={-1} onChange={(event) => { void convert(event.target.files?.[0]); event.target.value = ""; }} />
        <input ref={nfeInput} type="file" accept="application/pdf,.pdf" className="sr-only" aria-label="Selecionar NF-e" tabIndex={-1} onChange={(event) => { const file = event.target.files?.[0]; if (file) setNfe(file); event.target.value = ""; }} />

        <p className="relative mt-6 flex items-center justify-center gap-2 text-[11px] text-zinc-600"><ShieldCheck size={13} />PDF de até 5 MB · processado em memória, sem armazenamento</p>
      </div>
    </div>
  );
}
