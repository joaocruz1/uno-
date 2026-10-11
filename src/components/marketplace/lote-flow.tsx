"use client";

import { CheckCircle2, Download, FileText, LoaderCircle, Package, ShieldCheck, TriangleAlert, UploadCloud, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { z } from "zod";

import { Button, Progress } from "@/components/ui";
import { startPollingClock } from "@/components/conversion/use-polling-delay";
import { acceptedLoteSchema, loteDownloadSchema, loteViewSchema, type LoteView } from "@/lib/marketplace-model";
import { inspectPdf, putFile, requestUploadIntent, PDF_CONTENT_TYPE } from "@/lib/upload-client";

const MEBIBYTE = 1_024 * 1_024;
const PHASES: Record<string, string> = {
  queued: "Na fila",
  processing: "Convertendo os pedidos",
  packaging: "Montando o PDF do lote",
  completed: "Lote pronto",
  failed: "Lote interrompido",
};

function safeMessage(value: unknown, fallback: string): string {
  const body = value as { error?: { message?: unknown } } | null;
  return typeof body?.error?.message === "string" ? body.error.message : fallback;
}

type Phase = "idle" | "preparing" | "requesting" | "uploading" | "working" | "error";

export function LoteFlow({ planName, maxFileMB }: { planName: string; maxFileMB: number }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [fileName, setFileName] = useState<string>();
  const [error, setError] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const [loteId, setLoteId] = useState<string>();
  const [lote, setLote] = useState<LoteView>();
  const [downloading, setDownloading] = useState(false);

  // Numbering options, chosen before the upload is sent.
  const [numerar, setNumerar] = useState(true);
  const [letra, setLetra] = useState("");
  const [inicio, setInicio] = useState("1");
  const [mostrarTotal, setMostrarTotal] = useState(true);

  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef<XMLHttpRequest | null>(null);
  const operationRef = useRef(0);
  const busy = phase === "preparing" || phase === "requesting" || phase === "uploading";
  const maxBytes = maxFileMB * MEBIBYTE;

  const reset = () => {
    operationRef.current += 1;
    requestRef.current?.abort();
    requestRef.current = null;
    setPhase("idle"); setProgress(0); setFileName(undefined); setError(undefined);
    setLoteId(undefined); setLote(undefined);
    if (inputRef.current) inputRef.current.value = "";
  };

  const start = useCallback(async (file: File) => {
    const operation = ++operationRef.current;
    requestRef.current?.abort();
    setFileName(file.name); setError(undefined); setProgress(0); setLote(undefined); setLoteId(undefined);

    if (file.size < 1) { setPhase("error"); setError("O arquivo está vazio."); return; }
    if (file.size > maxBytes) { setPhase("error"); setError(`O arquivo excede o limite de ${maxFileMB} MB do plano ${planName}.`); return; }
    if (file.type && file.type !== PDF_CONTENT_TYPE) { setPhase("error"); setError("Selecione um arquivo PDF."); return; }

    const startNumber = Number(inicio);
    const numbering = numerar
      ? { ...(letra ? { letter: letra } : {}), start: Number.isInteger(startNumber) && startNumber >= 1 ? startNumber : 1, showTotal: mostrarTotal }
      : undefined;

    try {
      setPhase("preparing");
      const { checksumSha256 } = await inspectPdf(file);
      if (operationRef.current !== operation) return;
      setPhase("requesting");
      const intent = await requestUploadIntent(file, checksumSha256);
      if (operationRef.current !== operation) return;
      setPhase("uploading");
      await putFile(intent, file, setProgress, (request) => { requestRef.current = request; });
      if (operationRef.current !== operation) return;

      setPhase("working");
      const response = await fetch("/api/dashboard/marketplace-lotes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uploadIntentId: intent.id, marketplace: "mercado-livre", size: { preset: "100x150" }, ...(numbering ? { numbering } : {}) }),
        cache: "no-store",
      });
      const body: unknown = await response.json();
      if (operationRef.current !== operation) return;
      if (!response.ok) throw new Error(safeMessage(body, "Não foi possível criar o lote."));
      setLoteId(acceptedLoteSchema.parse(body).id);
    } catch (cause) {
      if (operationRef.current !== operation) return;
      requestRef.current = null;
      setPhase("error");
      setError(cause instanceof Error && !(cause instanceof z.ZodError) ? cause.message : "Não foi possível enviar o arquivo.");
    }
  }, [inicio, letra, maxBytes, maxFileMB, mostrarTotal, numerar, planName]);

  useEffect(() => {
    if (!loteId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const nextDelay = startPollingClock();
    const read = async () => {
      try {
        const response = await fetch(`/api/dashboard/marketplace-lotes/${loteId}`, { cache: "no-store", signal: controller.signal });
        const body: unknown = await response.json();
        if (controller.signal.aborted) return;
        if (!response.ok) throw new Error(safeMessage(body, "Não foi possível consultar o lote."));
        const next = loteViewSchema.parse(body);
        setLote(next);
        if (next.status === "queued" || next.status === "processing") timer = setTimeout(() => void read(), nextDelay());
      } catch (cause) {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error && !(cause instanceof z.ZodError) ? cause.message : "Não foi possível consultar o lote.");
      }
    };
    void read();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [loteId]);

  const download = async () => {
    if (!loteId || downloading) return;
    setDownloading(true);
    let objectUrl: string | undefined;
    try {
      const signed = await fetch(`/api/dashboard/marketplace-lotes/${loteId}/download`, { cache: "no-store" });
      const body: unknown = await signed.json();
      if (!signed.ok) throw new Error(safeMessage(body, "O PDF do lote não está disponível."));
      const { url } = loteDownloadSchema.parse(body);
      const file = await fetch(url, { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
      if (!file.ok) throw new Error("Não foi possível baixar o PDF.");
      objectUrl = URL.createObjectURL(await file.blob());
      const link = document.createElement("a");
      link.href = objectUrl; link.download = `uno-lote-${loteId}.pdf`;
      document.body.appendChild(link); link.click(); link.remove();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível baixar o PDF.");
    } finally {
      if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl!), 30_000);
      setDownloading(false);
    }
  };

  const receive = (files: FileList | null) => { const file = files?.item(0); if (file) void start(file); };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (busy) return;
    setDragging(false);
    if (event.dataTransfer.files.length !== 1) { setPhase("error"); setError("Envie um PDF por vez."); return; }
    receive(event.dataTransfer.files);
  };

  const done = lote?.status === "completed";
  const failed = lote?.status === "failed";
  const working = phase === "working" && !done && !failed;
  const processed = lote ? lote.completedCount + lote.failedCount : 0;
  const pct = lote && lote.itemCount > 0 ? Math.round((processed / lote.itemCount) * 100) : lote?.progress ?? 0;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <section className="overflow-hidden rounded-2xl border border-white/[.08] bg-[#050505]">
        <div className="border-b border-white/[.07] px-5 py-4 sm:px-7">
          <p className="font-heading text-lg font-semibold">Arquivo do marketplace</p>
          <p className="mt-1 text-sm text-zinc-500">O PDF de etiquetas do Mercado Livre, com vários pedidos.</p>
        </div>
        <div className="p-5 sm:p-7">
          {phase === "idle" ? (
            <div
              className={`grid min-h-72 place-items-center border border-dashed p-8 text-center transition-colors ${dragging ? "border-uno-red bg-uno-red/[.06]" : "border-white/15 bg-black hover:border-uno-red/50"}`}
              onDragEnter={(event) => { event.preventDefault(); if (!busy) setDragging(true); }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
              onDrop={onDrop}
            >
              <div className="max-w-md">
                <span className="mx-auto grid size-14 place-items-center rounded-full border border-uno-red/20 bg-uno-red/10 text-uno-red"><UploadCloud size={26} /></span>
                <h2 className="mt-5 font-heading text-xl font-bold">Arraste o PDF do lote aqui</h2>
                <p className="mt-2 text-sm leading-6 text-zinc-500">PDF do Mercado Livre · um arquivo · até {maxFileMB} MB no plano {planName}</p>
                <Button className="mt-6" onClick={() => inputRef.current?.click()}>Selecionar arquivo</Button>
              </div>
            </div>
          ) : (
            <div className="min-h-72 border border-white/[.08] bg-black p-5 sm:p-7" aria-live="polite">
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 gap-4">
                  <span className={`grid size-11 shrink-0 place-items-center rounded-full ${done ? "bg-emerald-400/10 text-emerald-400" : failed ? "bg-red-400/10 text-red-300" : "bg-uno-red/10 text-uno-red"}`}>
                    {done ? <CheckCircle2 size={21} /> : failed ? <TriangleAlert size={21} /> : <FileText size={21} />}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-white">{fileName}</p>
                    <p className="mt-1 text-xs text-zinc-500">{lote ? `${lote.itemCount} pedido${lote.itemCount === 1 ? "" : "s"}` : "PDF"}</p>
                  </div>
                </div>
                {!busy && (done || failed || phase === "error") ? (
                  <button type="button" onClick={reset} className="rounded-full p-2 text-zinc-500 hover:bg-white/[.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-uno-red" aria-label="Novo lote"><X size={18} /></button>
                ) : null}
              </div>

              <div className="mt-10">
                {busy ? (
                  <>
                    <div className="flex items-center gap-2 text-sm font-medium"><LoaderCircle className="animate-spin text-uno-red motion-reduce:animate-none" size={16} /><span>{phase === "uploading" ? `Enviando arquivo · ${progress}%` : phase === "requesting" ? "Preparando upload privado" : "Verificando o PDF"}</span></div>
                    {phase === "uploading" ? <Progress className="mt-4" value={progress} label="Progresso do envio" /> : <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/[.07]"><div className="h-full w-1/3 animate-pulse rounded-full bg-uno-red motion-reduce:animate-none" /></div>}
                  </>
                ) : null}

                {working ? (
                  <>
                    <div className="flex items-center gap-2 text-sm font-medium"><LoaderCircle className="animate-spin text-uno-red motion-reduce:animate-none" size={16} /><span>{PHASES[lote?.phase ?? "processing"] ?? "Processando o lote"}</span></div>
                    <Progress className="mt-4" value={pct} label="Progresso do lote" />
                    {lote ? <p className="mt-3 text-xs text-zinc-500">{processed} de {lote.itemCount} pedidos · a cota é confirmada por pedido que passa na validação.</p> : null}
                  </>
                ) : null}

                {done && lote ? (
                  <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/[.04] p-5">
                    <div className="flex items-center gap-3"><CheckCircle2 className="shrink-0 text-emerald-400" size={20} /><h3 className="font-heading font-semibold">PDF do lote pronto</h3></div>
                    <p className="mt-2 text-sm text-zinc-400">{lote.completedCount} etiqueta{lote.completedCount === 1 ? "" : "s"} 10×15{lote.failedCount > 0 ? ` · ${lote.failedCount} pedido${lote.failedCount === 1 ? "" : "s"} não passou na validação e ficou de fora` : ""}.</p>
                    <div className="mt-5 flex flex-wrap gap-3">
                      <Button onClick={() => void download()} disabled={!lote.downloadAvailable || downloading}>{downloading ? <LoaderCircle size={17} className="animate-spin motion-reduce:animate-none" /> : <Download size={17} />}Baixar PDF</Button>
                      <Button variant="secondary" onClick={reset}>Novo lote</Button>
                    </div>
                    <p className="mt-5 text-xs leading-5 text-zinc-500">Imprima em tamanho real (100%), sem ajustar à página. Confira a leitura dos códigos na sua térmica.</p>
                  </div>
                ) : null}

                {failed ? (
                  <div className="rounded-xl border border-red-400/20 bg-red-400/[.04] p-5">
                    <div className="flex items-center gap-3"><TriangleAlert className="shrink-0 text-red-300" size={20} /><h3 className="font-heading font-semibold">Não foi possível montar o lote</h3></div>
                    <p role="alert" className="mt-2 text-sm text-red-200">{lote?.error?.message ?? "Nenhum pedido do arquivo pôde ser convertido."}</p>
                    <p className="mt-2 text-xs text-zinc-500">Os pedidos que falharam não consumiram cota.</p>
                  </div>
                ) : null}

                {phase === "error" && error ? (
                  <>
                    <p role="alert" className="text-sm leading-6 text-red-300">{error}</p>
                    <Button className="mt-5" variant="secondary" onClick={reset}>Escolher outro arquivo</Button>
                  </>
                ) : null}
                {error && phase !== "error" ? <p role="alert" className="mt-3 text-xs text-amber-200">{error}</p> : null}
              </div>
            </div>
          )}
          <input ref={inputRef} type="file" accept="application/pdf,.pdf" className="sr-only" disabled={busy} onChange={(event) => receive(event.target.files)} aria-label="Selecionar PDF do lote" />
        </div>
      </section>

      <aside className="rounded-2xl border border-white/[.08] bg-[#050505] p-5 sm:p-6" aria-label="Opções do lote">
        <p className="font-heading text-lg font-semibold">Opções</p>
        <p className="mt-2 text-sm leading-6 text-zinc-500">Escolha antes de enviar: para mudar depois, converta de novo.</p>

        <div className="mt-5 rounded-xl border border-uno-red/40 bg-uno-red/[.06] px-4 py-3">
          <p className="flex items-center gap-2 text-sm font-medium text-zinc-200"><Package size={16} className="text-uno-red" />Mercado Livre</p>
          <p className="mt-1 text-[11px] text-zinc-500">Saída 10×15, uma etiqueta por pedido, num PDF só.</p>
        </div>

        <fieldset className="mt-6 border-t border-white/[.07] pt-5" disabled={busy || phase === "working"}>
          <label className="flex cursor-pointer items-center gap-3">
            <input type="checkbox" checked={numerar} onChange={(event) => setNumerar(event.currentTarget.checked)} className="accent-[#ef233c]" />
            <span className="text-sm font-medium text-zinc-200">Numerar pedidos</span>
          </label>
          <p className="mt-2 text-[11px] leading-5 text-zinc-600">Um número no topo de cada etiqueta, para conferir a pilha (ex.: 12/28).</p>

          {numerar ? (
            <div className="mt-4 grid grid-cols-2 gap-3">
              <label className="text-xs text-zinc-500">Letra do lote
                <input className="mt-2 w-full rounded-lg border border-white/[.1] bg-black px-3 py-2 text-sm text-white outline-none focus:border-uno-red" placeholder="—" maxLength={3} value={letra}
                  onChange={(event) => setLetra(event.currentTarget.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3))} />
              </label>
              <label className="text-xs text-zinc-500">Começar em
                <input className="mt-2 w-full rounded-lg border border-white/[.1] bg-black px-3 py-2 text-sm text-white outline-none focus:border-uno-red" type="number" min={1} max={99999} value={inicio}
                  onChange={(event) => setInicio(event.currentTarget.value)} />
              </label>
              <label className="col-span-2 flex cursor-pointer items-center gap-3 pt-1">
                <input type="checkbox" checked={mostrarTotal} onChange={(event) => setMostrarTotal(event.currentTarget.checked)} className="accent-[#ef233c]" />
                <span className="text-xs text-zinc-400">Mostrar o total ao lado (12/28)</span>
              </label>
            </div>
          ) : null}
        </fieldset>

        <div className="mt-7 flex gap-3 border-t border-white/[.07] pt-5 text-xs leading-5 text-zinc-500">
          <ShieldCheck className="mt-0.5 shrink-0 text-uno-red" size={17} />
          <p>Cada pedido passa pela mesma validação de códigos da UNO. Seus arquivos vão para armazenamento privado e não entram na telemetria.</p>
        </div>
      </aside>
    </div>
  );
}
