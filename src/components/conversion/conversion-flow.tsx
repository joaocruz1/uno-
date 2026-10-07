"use client";

import { CheckCircle2, Download, FileText, LoaderCircle, Printer, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Button, ButtonLink, Progress } from "@/components/ui";
import { acceptedConversionSchema, conversionViewSchema, type ConversionView } from "@/lib/conversion-model";
import { UploadPanel, type UploadedFile } from "./upload-panel";
import { PdfCanvasPreview } from "./pdf-preview";

const STAGES: Record<string, string> = {
  queued: "Na fila", analyze: "Conferindo o PDF", detect: "Identificando o modelo",
  extract: "Encontrando o conteúdo", layout: "Organizando os blocos", compose: "Montando a etiqueta",
  validate: "Validando conteúdo e códigos", completed: "Etiqueta pronta", failed: "Conversão interrompida",
};

function safeMessage(value: unknown, fallback: string): string {
  const body = value as { error?: { message?: unknown } } | null;
  return typeof body?.error?.message === "string" ? body.error.message : fallback;
}

function PdfPreview({ title, artifact, pages, pageCount }: { title: string; artifact: NonNullable<ConversionView["download"]>; pages: string; pageCount: 1 | 2 }) {
  return <section className="overflow-hidden rounded-2xl border border-white/10 bg-[#080808]">
    <div className="flex items-center justify-between gap-3 border-b border-white/[.08] px-5 py-4">
      <div><h3 className="font-heading font-semibold">{title}</h3><p className="mt-1 text-xs text-zinc-500">{pages}</p></div>
      <a href={artifact.url} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-zinc-300 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-uno-red">Abrir PDF</a>
    </div>
    <PdfCanvasPreview key={artifact.url} url={artifact.url} title={title} expectedPages={pageCount}/>
  </section>;
}

export function ConversionResult({ conversion, onRefresh }: { conversion: ConversionView; onRefresh: () => void }) {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string>();
  const download = async () => {
    if (!conversion.download || downloading) return;
    setDownloading(true);
    setDownloadError(undefined);
    let objectUrl: string | undefined;
    try {
      const response = await fetch(conversion.download.url, { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
      if (!response.ok) throw new Error("Não foi possível baixar o PDF. Atualize os links e tente novamente.");
      objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `uno-${conversion.id}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch {
      setDownloadError("Não foi possível baixar o PDF. Atualize os links e tente novamente.");
    } finally {
      if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl!), 30_000);
      setDownloading(false);
    }
  };
  return <div className="space-y-6">
    <section className="rounded-2xl border border-emerald-400/20 bg-emerald-400/[.04] p-5 sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div className="flex gap-3"><CheckCircle2 className="mt-1 shrink-0 text-emerald-400"/><div><h2 className="font-heading text-xl font-bold">Duas páginas. Uma etiqueta.</h2><p className="mt-2 text-sm text-zinc-400">Conteúdo e códigos validados · {conversion.size.widthMm} × {conversion.size.heightMm} mm</p></div></div>
        {conversion.download ? <div className="flex flex-wrap gap-3">
          <Button onClick={() => void download()} disabled={downloading}>{downloading ? <LoaderCircle size={17} className="animate-spin motion-reduce:animate-none"/> : <Download size={17}/>}Baixar PDF</Button>
          <ButtonLink href={conversion.download.url} target="_blank" rel="noopener noreferrer" variant="secondary"><Printer size={17}/>Imprimir</ButtonLink>
        </div> : <p className="text-sm text-zinc-400">Os arquivos expiraram conforme a retenção do plano.</p>}
      </div>
      {downloadError ? <p role="alert" className="mt-4 text-sm text-red-300">{downloadError}</p> : null}
      {conversion.download ? <p className="mt-5 text-xs leading-5 text-zinc-500">Na visualização do PDF, imprima em tamanho real / 100%, sem ajustar à página. Confira o papel e a leitura dos códigos na sua impressora.</p> : null}
    </section>
    {conversion.download && conversion.original ? <div className="grid gap-5 lg:grid-cols-2">
      <PdfPreview title="Antes" artifact={conversion.original} pages="Original · 2 páginas" pageCount={2}/>
      <PdfPreview title="Depois" artifact={conversion.download} pages="UNO · 1 página" pageCount={1}/>
    </div> : null}
    <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-zinc-500">
      <p className="flex items-center gap-2"><ShieldCheck size={15}/>Arquivos privados · links temporários</p>
      {conversion.download ? <Button variant="ghost" size="sm" onClick={onRefresh}><RefreshCw size={14}/>Atualizar links</Button> : null}
    </div>
  </div>;
}

export function ConversionFlow({ planName, maxFileMB }: { planName: string; maxFileMB: number }) {
  const [upload, setUpload] = useState<UploadedFile>();
  const [conversionId, setConversionId] = useState<string>();
  const [conversion, setConversion] = useState<ConversionView>();
  const [creating, setCreating] = useState(false);
  const [creationError, setCreationError] = useState<string>();
  const [pollError, setPollError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const operation = useRef(0);
  const creatingRef = useRef(false);

  const create = useCallback(async (file: UploadedFile) => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    const token = ++operation.current;
    setUpload(file);
    setCreating(true);
    setCreationError(undefined);
    try {
      const response = await fetch("/api/dashboard/conversions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uploadIntentId: file.intentId, size: file.output, ...(file.product ? { product: file.product } : {}) }), cache: "no-store" });
      const body: unknown = await response.json();
      if (operation.current !== token) return;
      if (!response.ok) {
        const recovery = z.object({ error: z.object({ code: z.literal("upload_already_consumed"), details: z.object({ conversionId: z.uuid() }) }) }).safeParse(body);
        if (recovery.success) { setConversionId(recovery.data.error.details.conversionId); return; }
        throw new Error(safeMessage(body, "Não foi possível criar a conversão."));
      }
      setConversionId(acceptedConversionSchema.parse(body).id);
    } catch (error) {
      if (operation.current === token) setCreationError(error instanceof Error && !(error instanceof z.ZodError) ? error.message : "Não foi possível confirmar a criação da conversão.");
    } finally {
      if (operation.current === token) { setCreating(false); creatingRef.current = false; }
    }
  }, []);

  useEffect(() => {
    if (!conversionId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const response = await fetch(`/api/dashboard/conversions/${conversionId}`, { cache: "no-store", signal: controller.signal });
        const body: unknown = await response.json();
        if (controller.signal.aborted) return;
        if (!response.ok) throw new Error(safeMessage(body, "Não foi possível consultar a conversão."));
        const next = conversionViewSchema.parse(body);
        setConversion(next);
        setPollError(undefined);
        if (next.status === "queued" || next.status === "processing") timer = setTimeout(() => void read(), 2_000);
      } catch (error) {
        if (controller.signal.aborted) return;
        setPollError(error instanceof Error && !(error instanceof z.ZodError) ? error.message : "Não foi possível consultar a conversão.");
      }
    };
    void read();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [conversionId, refresh]);

  const reset = () => {
    operation.current += 1;
    creatingRef.current = false;
    setUpload(undefined); setConversionId(undefined); setConversion(undefined);
    setCreating(false); setCreationError(undefined); setPollError(undefined);
  };

  if (!upload) return <UploadPanel planName={planName} maxFileMB={maxFileMB} onUploaded={(file) => void create(file)}/>;
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="max-w-full truncate text-sm text-zinc-400"><FileText size={15} className="mr-2 inline"/>{upload.fileName}</p>{!creating && (creationError || conversion?.status === "completed" || conversion?.status === "failed") ? <Button variant="secondary" size="sm" onClick={reset}>Nova conversão</Button> : null}</div>
    {creating || (!conversion && conversionId && !pollError) ? <section className="rounded-2xl border border-white/10 bg-[#080808] p-7" aria-live="polite"><LoaderCircle className="animate-spin text-uno-red motion-reduce:animate-none"/><h2 className="mt-5 font-heading text-xl font-semibold">{creating ? "Preparando sua conversão" : "Consultando a fila"}</h2><p className="mt-2 text-sm text-zinc-500">Você verá o progresso assim que o processamento começar.</p></section> : null}
    {creationError ? <section className="rounded-2xl border border-red-400/20 bg-red-400/[.04] p-6"><p role="alert" className="text-sm text-red-300">{creationError}</p><Button className="mt-5" onClick={() => void create(upload)}>Tentar novamente</Button></section> : null}
    {pollError ? <section className="rounded-2xl border border-amber-300/20 p-5"><p role="alert" className="text-sm text-amber-200">{pollError}</p><p className="mt-2 text-xs text-zinc-500">A consulta não interrompe o processamento.</p><Button className="mt-4" variant="secondary" onClick={() => setRefresh((value) => value + 1)}>Consultar novamente</Button></section> : null}
    {conversion?.status === "completed" ? <ConversionResult conversion={conversion} onRefresh={() => setRefresh((value) => value + 1)}/> : null}
    {conversion?.status === "failed" ? <section className="rounded-2xl border border-red-400/20 bg-red-400/[.04] p-6"><TriangleAlert className="text-red-300"/><h2 className="mt-4 font-heading text-xl font-semibold">Não foi possível unificar este PDF</h2><p role="alert" className="mt-3 text-sm leading-6 text-red-200">{conversion.error?.message ?? "O documento não passou na validação."}</p><p className="mt-3 text-xs text-zinc-500">Esta conversão não consumiu uma etiqueta da sua cota.</p></section> : null}
    {conversion && (conversion.status === "queued" || conversion.status === "processing") ? <section className="rounded-2xl border border-white/10 bg-[#080808] p-6 sm:p-8" aria-live="polite"><LoaderCircle className="animate-spin text-uno-red motion-reduce:animate-none"/><h2 className="mt-5 font-heading text-xl font-semibold">{STAGES[conversion.stage ?? conversion.status] ?? "Processando sua etiqueta"}</h2><Progress className="mt-6" value={conversion.progress} label="Progresso da conversão"/><p className="mt-4 text-xs leading-5 text-zinc-500">A cota será confirmada somente quando o PDF passar na validação.</p></section> : null}
  </div>;
}
