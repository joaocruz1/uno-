"use client";

import Link from "next/link";
import { ArrowRight, Check, Download, FileUp, LoaderCircle, RotateCcw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { PdfCanvasPreview } from "@/components/conversion/pdf-preview";

import { DanfeSheet, ShippingSheet } from "./label-art";

const MAX_BYTES = 5 * 1_024 * 1_024;
type Phase = "checking" | "idle" | "processing" | "done" | "used" | "error";

/** Landing hero: one anonymous conversion, rendered and downloadable on the spot. */
export function TrialDrop() {
  const input = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>("checking");
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState<string>();
  const [pdf, setPdf] = useState<Uint8Array>();
  const [href, setHref] = useState<string>();

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

  const convert = useCallback(async (file: File | undefined) => {
    if (!file || phase === "processing" || phase === "done" || phase === "used") return;
    if (file.type && file.type !== "application/pdf") { setPhase("error"); setMessage("Selecione um arquivo PDF."); return; }
    if (file.size > MAX_BYTES) { setPhase("error"); setMessage("O teste aceita PDFs de até 5 MB."); return; }
    setPhase("processing");
    setMessage(undefined);
    try {
      const form = new FormData();
      form.append("file", file, "etiqueta.pdf");
      const response = await fetch("/api/public/trial", { method: "POST", body: form, cache: "no-store" });
      if (!response.ok) {
        const body = await response.json().catch(() => undefined) as { error?: { code?: string; message?: string } } | undefined;
        if (body?.error?.code === "trial_used") { setPhase("used"); return; }
        setPhase("error");
        setMessage(body?.error?.message ?? "Não foi possível unificar este PDF. Tente novamente.");
        return;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      setPdf(bytes);
      setHref(URL.createObjectURL(new Blob([bytes], { type: "application/pdf" })));
      setPhase("done");
    } catch {
      setPhase("error");
      setMessage("Sem conexão com o servidor. Tente novamente.");
    }
  }, [phase]);

  const interactive = phase === "idle" || phase === "error";

  return (
    <div className="trial-frame relative mx-auto w-full max-w-2xl">
      <span className="corner-mark left-0 top-0" aria-hidden="true" />
      <span className="corner-mark right-0 top-0 rotate-90" aria-hidden="true" />
      <span className="corner-mark bottom-0 right-0 rotate-180" aria-hidden="true" />
      <span className="corner-mark bottom-0 left-0 -rotate-90" aria-hidden="true" />
      <div
        className={`relative min-h-[470px] overflow-hidden border bg-[#050505] p-5 transition-[border-color,box-shadow] duration-300 sm:p-8 ${dragging ? "border-uno-red shadow-[0_0_0_1px_rgba(239,35,60,.6),0_30px_120px_rgba(239,35,60,.35)]" : "border-white/10 shadow-[0_30px_100px_rgba(239,35,60,.12)]"}`}
        onDragOver={(event) => { if (interactive) { event.preventDefault(); setDragging(true); } }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => { event.preventDefault(); setDragging(false); if (interactive) void convert(event.dataTransfer.files[0]); }}
      >
        <div className="grid-pan absolute inset-0" aria-hidden="true" />
        <div className="relative flex items-center justify-between text-[10px] font-medium text-zinc-500 sm:text-[11px]">
          <span className="flex items-center gap-2"><span className="live-dot" aria-hidden="true" />TESTE GRÁTIS · 1 ETIQUETA</span>
          <span>SEM CADASTRO</span>
        </div>

        {phase === "done" && pdf && href ? (
          <div className="relative mt-6 grid items-center gap-6 sm:grid-cols-[minmax(0,210px)_1fr]">
            <div className="label-rise relative mx-auto w-full max-w-[210px]">
              <div className="absolute -inset-3 bg-uno-red/20 blur-2xl" aria-hidden="true" />
              <PdfCanvasPreview data={pdf} title="Etiqueta unificada" expectedPages={1} className="relative aspect-[2/3] overflow-hidden bg-white shadow-[0_18px_60px_rgba(0,0,0,.6)]" />
            </div>
            <div>
              <p className="inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-3 py-1 text-xs text-emerald-300"><Check size={13} />Etiqueta unificada</p>
              <h2 className="mt-4 font-heading text-2xl font-extrabold tracking-[-.03em]">Pronta para imprimir em 100 × 150 mm.</h2>
              <p className="mt-3 text-sm leading-6 text-zinc-400">Seu arquivo foi processado em memória e não ficou guardado. Este era o seu teste gratuito.</p>
              <a href={href} download="uno-etiqueta-unificada.pdf" className="mt-6 inline-flex h-12 w-full items-center justify-center gap-2 bg-uno-red px-6 text-sm font-semibold text-white transition hover:bg-[#ff3b52] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white sm:w-auto"><Download size={17} />Baixar etiqueta</a>
              <Link href="/register" className="mt-4 flex items-center gap-2 text-sm font-semibold text-zinc-200 hover:text-white">Criar conta e unir mais 10 por mês <ArrowRight size={15} /></Link>
            </div>
          </div>
        ) : phase === "used" ? (
          <div className="relative mt-16 text-center">
            <span className="mx-auto grid size-14 place-items-center rounded-full border border-uno-red/30 bg-uno-red/10 text-uno-red"><Check size={24} /></span>
            <h2 className="mt-6 font-heading text-2xl font-extrabold tracking-[-.03em]">Você já usou o teste gratuito.</h2>
            <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-zinc-400">Crie sua conta para continuar: o plano Free inclui 10 etiquetas por mês, com histórico e download a qualquer momento.</p>
            <Link href="/register" className="mt-7 inline-flex h-12 items-center justify-center gap-2 bg-uno-red px-7 text-sm font-semibold text-white transition hover:bg-[#ff3b52] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">Criar conta grátis <ArrowRight size={17} /></Link>
          </div>
        ) : (
          <div className="relative mt-6">
            <div className="relative grid min-h-[250px] place-items-center" aria-hidden="true">
              <div className="sheet-slot absolute left-1/2 w-28 sm:w-32" style={{ transform: phase === "processing" ? "translateX(-58%) rotate(-2deg)" : "translateX(-128%) rotate(-7deg)", opacity: phase === "processing" ? 0.8 : 1 }}><div className="sheet-float"><ShippingSheet /></div></div>
              <div className="sheet-slot absolute left-1/2 w-28 sm:w-32" style={{ transform: phase === "processing" ? "translateX(-42%) rotate(2deg)" : "translateX(28%) rotate(7deg)", opacity: phase === "processing" ? 0.8 : 1 }}><div className="sheet-float sheet-float-late"><DanfeSheet /></div></div>
              {phase === "processing" ? <div className="scan-beam absolute inset-x-6 top-0 h-px bg-uno-red" /> : null}
              <div className={`drop-target absolute grid size-24 place-items-center rounded-full border border-dashed ${dragging ? "border-uno-red bg-uno-red/20 text-white" : "border-white/25 bg-black/70 text-uno-red"}`}>
                {phase === "processing" ? <LoaderCircle size={30} className="animate-spin motion-reduce:animate-none" /> : <FileUp size={30} />}
              </div>
            </div>
            <div className="mt-4 text-center">
              {phase === "processing" ? (
                <p role="status" className="font-heading text-xl font-bold">Unificando sua etiqueta…</p>
              ) : (
                <>
                  <h2 className="font-heading text-2xl font-extrabold tracking-[-.03em]">{dragging ? "Pode soltar." : "Jogue sua etiqueta aqui."}</h2>
                  <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-zinc-400">Arraste o PDF de duas páginas (etiqueta + DANFE) e receba a etiqueta única na hora.</p>
                  {phase === "error" && message ? <p role="alert" className="mx-auto mt-3 flex max-w-sm items-center justify-center gap-2 text-sm text-red-300"><RotateCcw size={14} />{message}</p> : null}
                  <button type="button" disabled={phase === "checking"} onClick={() => input.current?.click()} className="mt-5 inline-flex h-11 items-center justify-center gap-2 border border-white/15 bg-white px-6 text-sm font-semibold text-black transition hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-uno-red disabled:opacity-60">Selecionar PDF</button>
                </>
              )}
              <input ref={input} type="file" accept="application/pdf,.pdf" className="sr-only" aria-label="Selecionar PDF para o teste gratuito" tabIndex={-1} onChange={(event) => { void convert(event.target.files?.[0]); event.target.value = ""; }} />
            </div>
          </div>
        )}

        <p className="relative mt-6 flex items-center justify-center gap-2 text-[11px] text-zinc-600"><ShieldCheck size={13} />PDF de até 5 MB · processado em memória, sem armazenamento</p>
      </div>
    </div>
  );
}
