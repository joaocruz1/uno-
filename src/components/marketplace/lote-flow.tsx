"use client";

import { ArrowDown, ArrowUp, CheckCircle2, Download, FileText, LoaderCircle, Plus, ShieldCheck, TriangleAlert, UploadCloud, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { z } from "zod";

import { Button, Progress } from "@/components/ui";
import { ChannelMark } from "@/components/marketplace-logos";
import { startPollingClock } from "@/components/conversion/use-polling-delay";
import { acceptedLoteSchema, loteDownloadSchema, loteViewSchema, type LoteView } from "@/lib/marketplace-model";
import { inspectPdf, putFile, requestUploadIntent, PDF_CONTENT_TYPE } from "@/lib/upload-client";

const MEBIBYTE = 1_024 * 1_024;
const MAX_FILES = 10;
// Marketplaces shown in the converter: Mercado Livre is live; the others are
// on the roadmap and appear disabled so the multi-channel direction is visible.
const MARKETPLACES = [
  { id: "mercado-livre" as const, name: "Mercado Livre", available: true },
  { id: "shopee" as const, name: "Shopee", available: false },
  { id: "tiktok" as const, name: "TikTok Shop", available: false },
];
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

type Picked = { file: File; key: string };
type Phase = "idle" | "uploading" | "working" | "error";

export function LoteFlow({ planName, maxFileMB }: { planName: string; maxFileMB: number }) {
  const [files, setFiles] = useState<Picked[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [uploadingIndex, setUploadingIndex] = useState(0);
  const [progress, setProgress] = useState(0);
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
  const uploading = phase === "uploading";
  const busy = uploading;
  const maxBytes = maxFileMB * MEBIBYTE;

  const reset = () => {
    operationRef.current += 1;
    requestRef.current?.abort();
    requestRef.current = null;
    setPhase("idle"); setProgress(0); setUploadingIndex(0); setError(undefined);
    setFiles([]); setLoteId(undefined); setLote(undefined);
    if (inputRef.current) inputRef.current.value = "";
  };

  const addFiles = (incoming: FileList | File[] | null) => {
    if (!incoming || busy) return;
    const chosen = Array.from(incoming);
    if (chosen.length === 0) return;
    setError(undefined);
    setFiles((current) => {
      const next = [...current];
      for (const file of chosen) {
        if (next.length >= MAX_FILES) { setError(`Máximo de ${MAX_FILES} arquivos por lote.`); break; }
        if (file.type && file.type !== PDF_CONTENT_TYPE) { setError("Envie apenas arquivos PDF."); continue; }
        if (file.size < 1) { setError("Um dos arquivos está vazio."); continue; }
        if (file.size > maxBytes) { setError(`Cada arquivo deve ter até ${maxFileMB} MB no plano ${planName}.`); continue; }
        next.push({ file, key: `${file.name}-${file.size}-${file.lastModified}-${next.length}-${Math.random().toString(36).slice(2, 7)}` });
      }
      return next;
    });
    if (inputRef.current) inputRef.current.value = "";
  };

  const move = (index: number, delta: number) => {
    setFiles((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };
  const removeAt = (index: number) => setFiles((current) => current.filter((_, i) => i !== index));

  const convert = useCallback(async () => {
    if (files.length === 0 || busy) return;
    const operation = ++operationRef.current;
    requestRef.current?.abort();
    setError(undefined); setProgress(0); setUploadingIndex(0); setLote(undefined); setLoteId(undefined);

    const startNumber = Number(inicio);
    const numbering = numerar
      ? { ...(letra ? { letter: letra } : {}), start: Number.isInteger(startNumber) && startNumber >= 1 ? startNumber : 1, showTotal: mostrarTotal }
      : undefined;

    try {
      setPhase("uploading");
      const uploadIntentIds: string[] = [];
      for (let index = 0; index < files.length; index += 1) {
        setUploadingIndex(index); setProgress(0);
        const { file } = files[index];
        const { checksumSha256 } = await inspectPdf(file);
        if (operationRef.current !== operation) return;
        const intent = await requestUploadIntent(file, checksumSha256);
        if (operationRef.current !== operation) return;
        await putFile(intent, file, setProgress, (request) => { requestRef.current = request; });
        if (operationRef.current !== operation) return;
        uploadIntentIds.push(intent.id);
      }

      setPhase("working");
      const response = await fetch("/api/dashboard/marketplace-lotes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uploadIntentIds, marketplace: "mercado-livre", size: { preset: "100x150" }, ...(numbering ? { numbering } : {}) }),
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
      setError(cause instanceof Error && !(cause instanceof z.ZodError) ? cause.message : "Não foi possível enviar os arquivos.");
    }
  }, [files, busy, inicio, letra, mostrarTotal, numerar]);

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

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (busy) return;
    setDragging(false);
    addFiles(event.dataTransfer.files);
  };

  const done = lote?.status === "completed";
  const failed = lote?.status === "failed";
  const working = phase === "working" && !done && !failed;
  const processed = lote ? lote.completedCount + lote.failedCount : 0;
  const pct = lote && lote.itemCount > 0 ? Math.round((processed / lote.itemCount) * 100) : lote?.progress ?? 0;
  const showComposer = phase === "idle" || phase === "error";

  return (
    <div>
      <div className="mb-5 flex flex-wrap gap-2.5" role="group" aria-label="Marketplace">
        {MARKETPLACES.map((channel) => (
          <button
            key={channel.id}
            type="button"
            disabled={!channel.available}
            aria-pressed={channel.available}
            title={channel.available ? channel.name : `${channel.name} — em breve`}
            className={`flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm font-semibold transition-colors ${
              channel.available
                ? "border-uno-red bg-uno-red/[.06] text-[var(--color-ink)]"
                : "cursor-not-allowed border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-faint)]"
            }`}
          >
            <ChannelMark id={channel.id} size={22} muted={!channel.available} />
            {channel.name}
            {channel.available
              ? <span className="ml-0.5 rounded-full bg-[var(--color-ok-surface)] px-2 py-0.5 text-[10px] font-bold text-[var(--color-ok)]">Disponível</span>
              : <span className="ml-0.5 rounded-full bg-[var(--color-surface-2)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-faint)]">Em breve</span>}
          </button>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <section className="card-soft overflow-hidden rounded-2xl">
        <div className="flex items-center justify-between gap-4 border-b border-[var(--color-line)] px-5 py-4 sm:px-7">
          <div>
            <p className="font-heading text-lg font-semibold text-[var(--color-ink)]">Arquivos do marketplace</p>
            <p className="mt-1 text-sm text-[var(--color-muted)]">PDFs de etiquetas do Mercado Livre — arraste vários e reordene.</p>
          </div>
          {showComposer && files.length > 0 ? <span className="shrink-0 text-xs text-[var(--color-faint)]">{files.length}/{MAX_FILES}</span> : null}
        </div>

        <div className="p-5 sm:p-7">
          {showComposer ? (
            <div className="space-y-4">
              {files.length > 0 ? (
                <ul className="space-y-2" aria-label="Arquivos do lote">
                  {files.map((item, index) => (
                    <li key={item.key} className="flex items-center gap-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-2)] px-3 py-2.5">
                      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[var(--color-surface)] text-xs font-bold text-[var(--color-muted)] ring-1 ring-inset ring-[var(--color-line)]">{index + 1}</span>
                      <FileText size={18} className="shrink-0 text-uno-red" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-[var(--color-ink)]">{item.file.name}</span>
                        <span className="block text-xs text-[var(--color-faint)]">{(item.file.size / MEBIBYTE).toFixed(1)} MB</span>
                      </span>
                      <div className="flex shrink-0 items-center gap-0.5">
                        <button type="button" onClick={() => move(index, -1)} disabled={index === 0} className="grid size-8 place-items-center rounded-lg text-[var(--color-muted)] transition-colors hover:bg-[var(--hover-ink)] hover:text-[var(--color-ink)] disabled:opacity-30 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-uno-red" aria-label={`Mover ${item.file.name} para cima`}><ArrowUp size={16} /></button>
                        <button type="button" onClick={() => move(index, 1)} disabled={index === files.length - 1} className="grid size-8 place-items-center rounded-lg text-[var(--color-muted)] transition-colors hover:bg-[var(--hover-ink)] hover:text-[var(--color-ink)] disabled:opacity-30 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-uno-red" aria-label={`Mover ${item.file.name} para baixo`}><ArrowDown size={16} /></button>
                        <button type="button" onClick={() => removeAt(index)} className="grid size-8 place-items-center rounded-lg text-[var(--color-faint)] transition-colors hover:bg-[var(--hover-ink)] hover:text-uno-red focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-uno-red" aria-label={`Remover ${item.file.name}`}><X size={16} /></button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : null}

              {files.length < MAX_FILES ? (
                <div
                  className={`grid place-items-center rounded-xl border border-dashed p-6 text-center transition-colors ${files.length === 0 ? "min-h-64 p-8" : ""} ${dragging ? "border-uno-red bg-uno-red/[.06]" : "border-[var(--color-line-strong)] bg-[var(--color-surface-2)] hover:border-uno-red/60"}`}
                  onDragEnter={(event) => { event.preventDefault(); if (!busy) setDragging(true); }}
                  onDragOver={(event) => event.preventDefault()}
                  onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
                  onDrop={onDrop}
                >
                  <div className="max-w-md">
                    <span className="mx-auto grid size-12 place-items-center rounded-full border border-uno-red/20 bg-uno-red/10 text-uno-red"><UploadCloud size={22} /></span>
                    {files.length === 0 ? <h2 className="mt-4 font-heading text-xl font-bold text-[var(--color-ink)]">Arraste os PDFs do lote aqui</h2> : null}
                    <p className="mt-2 text-sm leading-6 text-[var(--color-muted)]">{files.length === 0 ? `Vários arquivos, até ${MAX_FILES}, ${maxFileMB} MB cada no plano ${planName}` : "Arraste mais PDFs ou"}</p>
                    <Button className="mt-4" variant={files.length === 0 ? "primary" : "secondary"} onClick={() => inputRef.current?.click()}>{files.length === 0 ? "Selecionar arquivos" : <><Plus size={16} />Adicionar</>}</Button>
                  </div>
                </div>
              ) : null}

              {files.length > 0 ? (
                <div className="flex flex-wrap items-center gap-3 border-t border-[var(--color-line)] pt-4">
                  <Button onClick={() => void convert()}>Converter {files.length} arquivo{files.length === 1 ? "" : "s"}</Button>
                  <button type="button" onClick={reset} className="text-sm font-medium text-[var(--color-muted)] underline-offset-4 hover:text-[var(--color-ink)] hover:underline">Limpar</button>
                </div>
              ) : null}

              {phase === "error" && error ? <p role="alert" className="text-sm font-medium leading-6 text-uno-red">{error}</p> : null}
              {phase !== "error" && error ? <p role="alert" className="text-xs text-[var(--color-warn)]">{error}</p> : null}
            </div>
          ) : (
            <div className="min-h-64 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-2)] p-5 sm:p-7" aria-live="polite">
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 gap-4">
                  <span className={`grid size-11 shrink-0 place-items-center rounded-full ${done ? "bg-[var(--color-ok-surface)] text-[var(--color-ok)]" : failed ? "bg-uno-red/10 text-uno-red" : "bg-uno-red/10 text-uno-red"}`}>
                    {done ? <CheckCircle2 size={21} /> : failed ? <TriangleAlert size={21} /> : <FileText size={21} />}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-[var(--color-ink)]">{files.length} arquivo{files.length === 1 ? "" : "s"}</p>
                    <p className="mt-1 text-xs text-[var(--color-muted)]">{lote ? `${lote.itemCount} pedido${lote.itemCount === 1 ? "" : "s"}` : "Mercado Livre"}</p>
                  </div>
                </div>
                {!busy && (done || failed) ? (
                  <button type="button" onClick={reset} className="rounded-full p-2 text-[var(--color-faint)] transition-colors hover:bg-[var(--hover-ink)] hover:text-[var(--color-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-uno-red" aria-label="Novo lote"><X size={18} /></button>
                ) : null}
              </div>

              <div className="mt-10">
                {uploading ? (
                  <>
                    <div className="flex items-center gap-2 text-sm font-medium text-[var(--color-ink)]"><LoaderCircle className="animate-spin text-uno-red motion-reduce:animate-none" size={16} /><span>Enviando arquivo {uploadingIndex + 1} de {files.length} · {progress}%</span></div>
                    <Progress className="mt-4" value={progress} label="Progresso do envio" />
                  </>
                ) : null}

                {working ? (
                  <>
                    <div className="flex items-center gap-2 text-sm font-medium text-[var(--color-ink)]"><LoaderCircle className="animate-spin text-uno-red motion-reduce:animate-none" size={16} /><span>{PHASES[lote?.phase ?? "processing"] ?? "Processando o lote"}</span></div>
                    <Progress className="mt-4" value={pct} label="Progresso do lote" />
                    {lote ? <p className="mt-3 text-xs text-[var(--color-muted)]">{processed} de {lote.itemCount} pedidos · a cota é confirmada por pedido que passa na validação.</p> : null}
                  </>
                ) : null}

                {done && lote ? (
                  <div className="rounded-xl border border-[var(--color-ok)]/30 bg-[var(--color-ok-surface)] p-5">
                    <div className="flex items-center gap-3"><CheckCircle2 className="shrink-0 text-[var(--color-ok)]" size={20} /><h3 className="font-heading font-semibold text-[var(--color-ink)]">PDF do lote pronto</h3></div>
                    <p className="mt-2 text-sm text-[var(--color-muted)]">{lote.completedCount} etiqueta{lote.completedCount === 1 ? "" : "s"} 10×15{lote.failedCount > 0 ? ` · ${lote.failedCount} pedido${lote.failedCount === 1 ? "" : "s"} não passou na validação e ficou de fora` : ""}.</p>
                    <div className="mt-5 flex flex-wrap gap-3">
                      <Button onClick={() => void download()} disabled={!lote.downloadAvailable || downloading}>{downloading ? <LoaderCircle size={17} className="animate-spin motion-reduce:animate-none" /> : <Download size={17} />}Baixar PDF</Button>
                      <Button variant="secondary" onClick={reset}>Novo lote</Button>
                    </div>
                    <p className="mt-5 text-xs leading-5 text-[var(--color-muted)]">Imprima em tamanho real (100%), sem ajustar à página. Confira a leitura dos códigos na sua térmica.</p>
                  </div>
                ) : null}

                {failed ? (
                  <div className="rounded-xl border border-uno-red/25 bg-uno-red/[.05] p-5">
                    <div className="flex items-center gap-3"><TriangleAlert className="shrink-0 text-uno-red" size={20} /><h3 className="font-heading font-semibold text-[var(--color-ink)]">Não foi possível montar o lote</h3></div>
                    <p role="alert" className="mt-2 text-sm text-[var(--color-ink)]">{lote?.error?.message ?? "Nenhum pedido do arquivo pôde ser convertido."}</p>
                    <p className="mt-2 text-xs text-[var(--color-muted)]">Os pedidos que falharam não consumiram cota.</p>
                    <Button className="mt-5" variant="secondary" onClick={reset}>Tentar de novo</Button>
                  </div>
                ) : null}

                {error && (working || uploading) ? <p role="alert" className="mt-3 text-xs text-[var(--color-warn)]">{error}</p> : null}
              </div>
            </div>
          )}
          <input ref={inputRef} type="file" accept="application/pdf,.pdf" multiple className="sr-only" disabled={busy} onChange={(event) => addFiles(event.target.files)} aria-label="Selecionar PDFs do lote" />
        </div>
      </section>

      <aside className="card-soft h-fit rounded-2xl p-5 sm:p-6" aria-label="Opções do lote">
        <p className="font-heading text-lg font-semibold text-[var(--color-ink)]">Opções</p>
        <p className="mt-2 text-sm leading-6 text-[var(--color-muted)]">Escolha antes de enviar: para mudar depois, converta de novo.</p>

        <div className="mt-5 flex items-center gap-3 rounded-xl border border-uno-red/30 bg-uno-red/[.05] px-4 py-3">
          <ChannelMark id="mercado-livre" size={34} />
          <div>
            <p className="text-sm font-semibold text-[var(--color-ink)]">Mercado Livre</p>
            <p className="mt-0.5 text-[11px] text-[var(--color-muted)]">Saída 10×15, uma etiqueta por pedido, num PDF só.</p>
          </div>
        </div>

        <fieldset className="mt-6 border-t border-[var(--color-line)] pt-5" disabled={busy || phase === "working"}>
          <label className="flex cursor-pointer items-center gap-3">
            <input type="checkbox" checked={numerar} onChange={(event) => setNumerar(event.currentTarget.checked)} className="size-4 accent-[#ef233c]" />
            <span className="text-sm font-medium text-[var(--color-ink)]">Numerar pedidos</span>
          </label>
          <p className="mt-2 text-[11px] leading-5 text-[var(--color-faint)]">Um número no topo de cada etiqueta, para conferir a pilha (ex.: 12/28).</p>

          {numerar ? (
            <div className="mt-4 grid grid-cols-2 gap-3">
              <label className="text-xs text-[var(--color-muted)]">Letra do lote
                <input className="mt-2 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] px-3 py-2 text-sm text-[var(--color-ink)] outline-none focus:border-uno-red" placeholder="—" maxLength={3} value={letra}
                  onChange={(event) => setLetra(event.currentTarget.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3))} />
              </label>
              <label className="text-xs text-[var(--color-muted)]">Começar em
                <input className="mt-2 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] px-3 py-2 text-sm text-[var(--color-ink)] outline-none focus:border-uno-red" type="number" min={1} max={99999} value={inicio}
                  onChange={(event) => setInicio(event.currentTarget.value)} />
              </label>
              <label className="col-span-2 flex cursor-pointer items-center gap-3 pt-1">
                <input type="checkbox" checked={mostrarTotal} onChange={(event) => setMostrarTotal(event.currentTarget.checked)} className="size-4 accent-[#ef233c]" />
                <span className="text-xs text-[var(--color-muted)]">Mostrar o total ao lado (12/28)</span>
              </label>
            </div>
          ) : null}
        </fieldset>

        <div className="mt-7 flex gap-3 border-t border-[var(--color-line)] pt-5 text-xs leading-5 text-[var(--color-muted)]">
          <ShieldCheck className="mt-0.5 shrink-0 text-uno-red" size={17} />
          <p>Cada pedido passa pela mesma validação de códigos da UNO. Seus arquivos vão para armazenamento privado e não entram na telemetria.</p>
        </div>
      </aside>
      </div>
    </div>
  );
}
