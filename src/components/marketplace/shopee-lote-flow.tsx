"use client";

import { ArrowDown, ArrowUp, CheckCircle2, Download, FileText, LoaderCircle, Plus, ShieldCheck, TriangleAlert, UploadCloud, X } from "lucide-react";
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
type Done = { orderCount: number; succeeded: number; failed: number };

export function ShopeeLoteFlow({ planName, maxFileMB }: { planName: string; maxFileMB: number }) {
  const [files, setFiles] = useState<Picked[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const [done, setDone] = useState<Done>();

  const [numerar, setNumerar] = useState(true);
  const [letra, setLetra] = useState("");
  const [inicio, setInicio] = useState("1");
  const [mostrarTotal, setMostrarTotal] = useState(true);

  const inputRef = useRef<HTMLInputElement>(null);
  const maxBytes = maxFileMB * MEBIBYTE;

  const addFiles = (incoming: FileList | File[] | null) => {
    if (!incoming || busy) return;
    const chosen = Array.from(incoming);
    if (chosen.length === 0) return;
    setError(undefined);
    setFiles((current) => {
      const next = [...current];
      for (const file of chosen) {
        if (next.length >= MAX_FILES) { setError(`Máximo de ${MAX_FILES} arquivos por lote.`); break; }
        if (file.type && file.type !== PDF_CONTENT_TYPE) { setError("Envie apenas PDFs de etiquetas da Shopee."); continue; }
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

  const reset = () => {
    setFiles([]); setError(undefined); setDone(undefined); setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
  };

  const convert = async () => {
    if (files.length === 0 || busy) return;
    setBusy(true); setError(undefined); setDone(undefined);
    let objectUrl: string | undefined;
    try {
      const form = new FormData();
      for (const { file } of files) form.append("file", file);
      const start = Number(inicio);
      const params = new URLSearchParams({
        numerar: numerar ? "1" : "0",
        ...(numerar && letra ? { letra } : {}),
        inicio: Number.isInteger(start) && start >= 1 ? String(start) : "1",
        total: mostrarTotal ? "1" : "0",
      });
      const response = await fetch(`/api/dashboard/shopee-lote?${params}`, { method: "POST", body: form, cache: "no-store" });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        throw new Error(safeMessage(body, "Não foi possível montar o lote."));
      }
      const orderCount = Number(response.headers.get("x-uno-orders") ?? 0);
      const succeeded = Number(response.headers.get("x-uno-succeeded") ?? 0);
      const failed = Number(response.headers.get("x-uno-failed") ?? 0);
      objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = objectUrl; link.download = "uno-lote-shopee.pdf";
      document.body.appendChild(link); link.click(); link.remove();
      setDone({ orderCount, succeeded, failed });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível montar o lote.");
    } finally {
      if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl!), 30_000);
      setBusy(false);
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (busy) return;
    setDragging(false);
    addFiles(event.dataTransfer.files);
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <section className="card-soft overflow-hidden rounded-2xl">
        <div className="flex items-center justify-between gap-4 border-b border-[var(--color-line)] px-5 py-4 sm:px-7">
          <div className="flex items-center gap-3">
            <ChannelMark id="shopee" size={24} />
            <div>
              <p className="font-heading text-lg font-semibold text-[var(--color-ink)]">Etiquetas da Shopee</p>
              <p className="mt-1 text-sm text-[var(--color-muted)]">PDF de etiquetas 10×15 — arraste vários e reordene.</p>
            </div>
          </div>
          {files.length > 0 && !done ? <span className="shrink-0 text-xs text-[var(--color-faint)]">{files.length}/{MAX_FILES}</span> : null}
        </div>

        <div className="p-5 sm:p-7">
          {done ? (
            <div className="rounded-xl border border-[var(--color-ok)]/30 bg-[var(--color-ok-surface)] p-5">
              <div className="flex items-center gap-3"><CheckCircle2 className="shrink-0 text-[var(--color-ok)]" size={20} /><h3 className="font-heading font-semibold text-[var(--color-ink)]">PDF do lote pronto</h3></div>
              <p className="mt-2 text-sm text-[var(--color-muted)]">{done.succeeded} etiqueta{done.succeeded === 1 ? "" : "s"} 10×15{done.failed > 0 ? ` · ${done.failed} não passou na validação e ficou de fora` : ""}.</p>
              <div className="mt-5 flex flex-wrap gap-3"><Button variant="secondary" onClick={reset}>Novo lote</Button></div>
              <p className="mt-5 text-xs leading-5 text-[var(--color-muted)]">Imprima em tamanho real (100%), sem ajustar à página. Confira a leitura dos códigos na sua térmica.</p>
            </div>
          ) : (
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
                        <button type="button" onClick={() => move(index, -1)} disabled={index === 0 || busy} className="grid size-8 place-items-center rounded-lg text-[var(--color-muted)] transition-colors hover:bg-[var(--hover-ink)] hover:text-[var(--color-ink)] disabled:opacity-30 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-uno-red" aria-label={`Mover ${item.file.name} para cima`}><ArrowUp size={16} /></button>
                        <button type="button" onClick={() => move(index, 1)} disabled={index === files.length - 1 || busy} className="grid size-8 place-items-center rounded-lg text-[var(--color-muted)] transition-colors hover:bg-[var(--hover-ink)] hover:text-[var(--color-ink)] disabled:opacity-30 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-uno-red" aria-label={`Mover ${item.file.name} para baixo`}><ArrowDown size={16} /></button>
                        <button type="button" onClick={() => removeAt(index)} disabled={busy} className="grid size-8 place-items-center rounded-lg text-[var(--color-faint)] transition-colors hover:bg-[var(--hover-ink)] hover:text-uno-red disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-uno-red" aria-label={`Remover ${item.file.name}`}><X size={16} /></button>
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
                    {files.length === 0 ? <h2 className="mt-4 font-heading text-xl font-bold text-[var(--color-ink)]">Arraste os PDFs da Shopee aqui</h2> : null}
                    <p className="mt-2 text-sm leading-6 text-[var(--color-muted)]">{files.length === 0 ? `Vários arquivos, até ${MAX_FILES}, ${maxFileMB} MB cada no plano ${planName}` : "Arraste mais PDFs ou"}</p>
                    <Button className="mt-4" variant={files.length === 0 ? "primary" : "secondary"} onClick={() => inputRef.current?.click()}>{files.length === 0 ? "Selecionar arquivos" : <><Plus size={16} />Adicionar</>}</Button>
                  </div>
                </div>
              ) : null}

              {files.length > 0 ? (
                <div className="flex flex-wrap items-center gap-3 border-t border-[var(--color-line)] pt-4">
                  <Button onClick={() => void convert()} disabled={busy}>{busy ? <LoaderCircle size={17} className="animate-spin motion-reduce:animate-none" /> : <Download size={17} />}Montar lote</Button>
                  <button type="button" onClick={reset} disabled={busy} className="text-sm font-medium text-[var(--color-muted)] underline-offset-4 hover:text-[var(--color-ink)] hover:underline disabled:opacity-40">Limpar</button>
                  {busy ? <span className="text-xs text-[var(--color-muted)]">Validando os códigos…</span> : null}
                </div>
              ) : null}

              {error ? <p role="alert" className="flex items-start gap-2 text-sm font-medium leading-6 text-uno-red"><TriangleAlert size={17} className="mt-0.5 shrink-0" />{error}</p> : null}
            </div>
          )}
          <input ref={inputRef} type="file" accept="application/pdf,.pdf" multiple className="sr-only" disabled={busy} onChange={(event) => addFiles(event.target.files)} aria-label="Selecionar PDFs da Shopee" />
        </div>
      </section>

      <aside className="card-soft h-fit rounded-2xl p-5 sm:p-6" aria-label="Opções do lote">
        <p className="font-heading text-lg font-semibold text-[var(--color-ink)]">Opções</p>
        <p className="mt-2 text-sm leading-6 text-[var(--color-muted)]">Escolha antes de montar o lote.</p>

        <div className="mt-5 flex items-center gap-3 rounded-xl border border-uno-red/30 bg-uno-red/[.05] px-4 py-3">
          <ChannelMark id="shopee" size={34} />
          <div>
            <p className="text-sm font-semibold text-[var(--color-ink)]">Shopee</p>
            <p className="mt-0.5 text-[11px] text-[var(--color-muted)]">Cada etiqueta 10×15 validada, num PDF só.</p>
          </div>
        </div>

        <fieldset className="mt-6 border-t border-[var(--color-line)] pt-5" disabled={busy}>
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
          <p>Cada etiqueta é conferida (o código de barras precisa decodificar) antes de entrar no PDF. Os arquivos são processados na hora e não entram na telemetria.</p>
        </div>
      </aside>
    </div>
  );
}
