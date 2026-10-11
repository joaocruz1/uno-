"use client";

import { CheckCircle2, Download, FileText, LoaderCircle, Plus, ShieldCheck, TriangleAlert, UploadCloud, X } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";

import { Button } from "@/components/ui";
import { ChannelMark } from "@/components/marketplace-logos";
import { PDF_CONTENT_TYPE } from "@/lib/upload-client";

const MEBIBYTE = 1_024 * 1_024;
const MAX_FILES = 10;

function safeMessage(value: unknown, fallback: string): string {
  const body = value as { error?: { message?: unknown } } | null;
  return typeof body?.error?.message === "string" ? body.error.message : fallback;
}

type Picked = { file: File; key: string };
type Done = { orders: number; matched: number; unmatchedLabels: number; unmatchedInvoices: number };

function FileList({ files, onRemove, busy }: { files: Picked[]; onRemove: (index: number) => void; busy: boolean }) {
  if (files.length === 0) return null;
  return (
    <ul className="space-y-2">
      {files.map((item, index) => (
        <li key={item.key} className="flex items-center gap-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-2)] px-3 py-2.5">
          <FileText size={18} className="shrink-0 text-uno-red" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-[var(--color-ink)]">{item.file.name}</span>
            <span className="block text-xs text-[var(--color-faint)]">{(item.file.size / MEBIBYTE).toFixed(1)} MB</span>
          </span>
          <button type="button" onClick={() => onRemove(index)} disabled={busy} className="grid size-8 shrink-0 place-items-center rounded-lg text-[var(--color-faint)] transition-colors hover:bg-[var(--hover-ink)] hover:text-uno-red disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-uno-red" aria-label={`Remover ${item.file.name}`}><X size={16} /></button>
        </li>
      ))}
    </ul>
  );
}

function Dropzone({ title, hint, files, setFiles, busy, maxFileMB, planName, setError }: {
  title: string; hint: string; files: Picked[]; setFiles: React.Dispatch<React.SetStateAction<Picked[]>>;
  busy: boolean; maxFileMB: number; planName: string; setError: (message: string | undefined) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const maxBytes = maxFileMB * MEBIBYTE;

  const add = (incoming: FileList | File[] | null) => {
    if (!incoming || busy) return;
    setError(undefined);
    setFiles((current) => {
      const next = [...current];
      for (const file of Array.from(incoming)) {
        if (next.length >= MAX_FILES) { setError(`Máximo de ${MAX_FILES} arquivos.`); break; }
        if (file.type && file.type !== PDF_CONTENT_TYPE) { setError("Envie apenas PDFs."); continue; }
        if (file.size < 1) { setError("Um dos arquivos está vazio."); continue; }
        if (file.size > maxBytes) { setError(`Cada arquivo deve ter até ${maxFileMB} MB no plano ${planName}.`); continue; }
        next.push({ file, key: `${file.name}-${file.size}-${file.lastModified}-${next.length}-${Math.random().toString(36).slice(2, 7)}` });
      }
      return next;
    });
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <div>
      <p className="text-sm font-semibold text-[var(--color-ink)]">{title}</p>
      <p className="mt-0.5 text-xs text-[var(--color-muted)]">{hint}</p>
      <div className="mt-3 space-y-3">
        <FileList files={files} onRemove={(index) => setFiles((current) => current.filter((_, i) => i !== index))} busy={busy} />
        {files.length < MAX_FILES ? (
          <div
            className={`grid place-items-center rounded-xl border border-dashed p-5 text-center transition-colors ${dragging ? "border-uno-red bg-uno-red/[.06]" : "border-[var(--color-line-strong)] bg-[var(--color-surface-2)] hover:border-uno-red/60"}`}
            onDragEnter={(event) => { event.preventDefault(); if (!busy) setDragging(true); }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
            onDrop={(event: DragEvent<HTMLDivElement>) => { event.preventDefault(); if (busy) return; setDragging(false); add(event.dataTransfer.files); }}
          >
            <div>
              <span className="mx-auto grid size-10 place-items-center rounded-full border border-uno-red/20 bg-uno-red/10 text-uno-red"><UploadCloud size={18} /></span>
              <p className="mt-2 text-xs text-[var(--color-muted)]">{files.length === 0 ? "Arraste os PDFs ou" : "Mais PDFs ou"}</p>
              <Button className="mt-2" size="sm" variant="secondary" onClick={() => inputRef.current?.click()}><Plus size={15} />Selecionar</Button>
            </div>
          </div>
        ) : null}
      </div>
      <input ref={inputRef} type="file" accept="application/pdf,.pdf" multiple className="sr-only" disabled={busy} onChange={(event) => add(event.target.files)} aria-label={title} />
    </div>
  );
}

export function TikTokLoteFlow({ planName, maxFileMB }: { planName: string; maxFileMB: number }) {
  const [labels, setLabels] = useState<Picked[]>([]);
  const [invoices, setInvoices] = useState<Picked[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<Done>();

  const reset = () => { setLabels([]); setInvoices([]); setError(undefined); setDone(undefined); setBusy(false); };

  const convert = async () => {
    if (labels.length === 0 || busy) return;
    setBusy(true); setError(undefined); setDone(undefined);
    let objectUrl: string | undefined;
    try {
      const form = new FormData();
      for (const { file } of labels) form.append("label", file);
      for (const { file } of invoices) form.append("nfe", file);
      const response = await fetch("/api/dashboard/tiktok-lote", { method: "POST", body: form, cache: "no-store" });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        throw new Error(safeMessage(body, "Não foi possível montar o lote."));
      }
      const num = (header: string) => Number(response.headers.get(header) ?? 0);
      objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = objectUrl; link.download = "uno-lote-tiktok.pdf";
      document.body.appendChild(link); link.click(); link.remove();
      setDone({ orders: num("x-uno-orders"), matched: num("x-uno-matched"), unmatchedLabels: num("x-uno-unmatched-labels"), unmatchedInvoices: num("x-uno-unmatched-invoices") });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível montar o lote.");
    } finally {
      if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl!), 30_000);
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <section className="card-soft overflow-hidden rounded-2xl">
        <div className="flex items-center gap-3 border-b border-[var(--color-line)] px-5 py-4 sm:px-7">
          <ChannelMark id="tiktok" size={24} />
          <div>
            <p className="font-heading text-lg font-semibold text-[var(--color-ink)]">Etiquetas e notas do TikTok</p>
            <p className="mt-1 text-sm text-[var(--color-muted)]">Cada etiqueta sai seguida da sua NF-e, casadas pelo pedido.</p>
          </div>
        </div>

        <div className="space-y-6 p-5 sm:p-7">
          {done ? (
            <div className="rounded-xl border border-[var(--color-ok)]/30 bg-[var(--color-ok-surface)] p-5">
              <div className="flex items-center gap-3"><CheckCircle2 className="shrink-0 text-[var(--color-ok)]" size={20} /><h3 className="font-heading font-semibold text-[var(--color-ink)]">PDF do lote pronto</h3></div>
              <p className="mt-2 text-sm text-[var(--color-muted)]">{done.orders} etiqueta{done.orders === 1 ? "" : "s"} · {done.matched} com NF-e casada{done.unmatchedLabels > 0 ? ` · ${done.unmatchedLabels} sem NF-e` : ""}{done.unmatchedInvoices > 0 ? ` · ${done.unmatchedInvoices} NF-e sem etiqueta` : ""}.</p>
              <div className="mt-5"><Button variant="secondary" onClick={reset}>Novo lote</Button></div>
              <p className="mt-5 text-xs leading-5 text-[var(--color-muted)]">Imprima em tamanho real (100%), sem ajustar à página.</p>
            </div>
          ) : (
            <>
              <Dropzone title="Etiquetas (shipping label + packing slip)" hint="PDF que o TikTok gera com etiqueta e romaneio." files={labels} setFiles={setLabels} busy={busy} maxFileMB={maxFileMB} planName={planName} setError={setError} />
              <Dropzone title="Notas fiscais (NF-e) — opcional" hint="PDF das NF-e; cada uma é casada com o pedido da etiqueta." files={invoices} setFiles={setInvoices} busy={busy} maxFileMB={maxFileMB} planName={planName} setError={setError} />

              <div className="flex flex-wrap items-center gap-3 border-t border-[var(--color-line)] pt-5">
                <Button onClick={() => void convert()} disabled={busy || labels.length === 0}>{busy ? <LoaderCircle size={17} className="animate-spin motion-reduce:animate-none" /> : <Download size={17} />}Montar lote</Button>
                <button type="button" onClick={reset} disabled={busy} className="text-sm font-medium text-[var(--color-muted)] underline-offset-4 hover:text-[var(--color-ink)] hover:underline disabled:opacity-40">Limpar</button>
                {busy ? <span className="text-xs text-[var(--color-muted)]">Casando etiquetas e notas…</span> : null}
              </div>
              {error ? <p role="alert" className="flex items-start gap-2 text-sm font-medium leading-6 text-uno-red"><TriangleAlert size={17} className="mt-0.5 shrink-0" />{error}</p> : null}
            </>
          )}
        </div>
      </section>

      <aside className="card-soft h-fit rounded-2xl p-5 sm:p-6" aria-label="Sobre o lote do TikTok">
        <div className="flex items-center gap-3 rounded-xl border border-uno-red/30 bg-uno-red/[.05] px-4 py-3">
          <ChannelMark id="tiktok" size={34} />
          <div>
            <p className="text-sm font-semibold text-[var(--color-ink)]">TikTok Shop</p>
            <p className="mt-0.5 text-[11px] text-[var(--color-muted)]">Etiqueta seguida da NF-e, num PDF só.</p>
          </div>
        </div>
        <p className="mt-5 text-sm leading-6 text-[var(--color-muted)]">A NF-e é casada com a etiqueta pelo número do pedido lido nos dois documentos. Uma etiqueta sem NF-e entra mesmo assim e é sinalizada.</p>
        <div className="mt-7 flex gap-3 border-t border-[var(--color-line)] pt-5 text-xs leading-5 text-[var(--color-muted)]">
          <ShieldCheck className="mt-0.5 shrink-0 text-uno-red" size={17} />
          <p>Os PDFs são lidos na hora para casar e ordenar, e descartados em seguida — nada é gravado nem entra na telemetria.</p>
        </div>
      </aside>
    </div>
  );
}
