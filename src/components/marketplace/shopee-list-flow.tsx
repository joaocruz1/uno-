"use client";

import { Download, FileSpreadsheet, LoaderCircle, ShieldCheck, TriangleAlert, UploadCloud, X } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";

import { Button } from "@/components/ui";
import { ChannelMark } from "@/components/marketplace-logos";

const MEBIBYTE = 1_024 * 1_024;
const MAX_BYTES = 10 * MEBIBYTE;
const EXCEL_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
]);

type Order = "soma" | "por-pedido" | "agrupada";
type Paper = "a4" | "10x15";

const ORDER_OPTIONS: { id: Order; label: string; hint: string }[] = [
  { id: "soma", label: "Soma por SKU", hint: "Uma linha por SKU, com o total e em quais pedidos ele aparece." },
  { id: "por-pedido", label: "Por pedido", hint: "Um bloco por pedido, na ordem da planilha." },
  { id: "agrupada", label: "Agrupada por SKU", hint: "Pedidos reordenados para juntar o mesmo SKU." },
];

function safeMessage(value: unknown, fallback: string): string {
  const body = value as { error?: { message?: unknown } } | null;
  return typeof body?.error?.message === "string" ? body.error.message : fallback;
}

export function ShopeeListFlow() {
  const [file, setFile] = useState<File>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [dragging, setDragging] = useState(false);

  const [order, setOrder] = useState<Order>("soma");
  const [paper, setPaper] = useState<Paper>("a4");
  const [perPage, setPerPage] = useState<15 | 30 | 50>(30);
  const [sector, setSector] = useState("");
  const [saleData, setSaleData] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);

  const pick = (incoming: FileList | File[] | null) => {
    if (!incoming || busy) return;
    const chosen = Array.from(incoming)[0];
    if (!chosen) return;
    setError(undefined);
    const looksExcel = EXCEL_TYPES.has(chosen.type) || /\.xlsx?$/i.test(chosen.name);
    if (!looksExcel) { setError("Envie a planilha da lista de embalagem (.xlsx) da Shopee."); return; }
    if (chosen.size < 1) { setError("A planilha está vazia."); return; }
    if (chosen.size > MAX_BYTES) { setError("A planilha excede 10 MB."); return; }
    setFile(chosen);
    if (inputRef.current) inputRef.current.value = "";
  };

  const reset = () => {
    setFile(undefined); setError(undefined); setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
  };

  const generate = async () => {
    if (!file || busy) return;
    setBusy(true); setError(undefined);
    let objectUrl: string | undefined;
    try {
      const params = new URLSearchParams({ order, paper, saleData: saleData ? "1" : "0" });
      if (paper === "a4") params.set("perPage", String(perPage));
      const cleanSector = sector.trim();
      if (cleanSector) params.set("sector", cleanSector);

      const response = await fetch(`/api/dashboard/shopee-list?${params}`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: file,
        cache: "no-store",
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        throw new Error(safeMessage(body, "Não foi possível gerar a lista."));
      }
      objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = objectUrl; link.download = "uno-lista-shopee.pdf";
      document.body.appendChild(link); link.click(); link.remove();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível gerar a lista.");
    } finally {
      if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl!), 30_000);
      setBusy(false);
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (busy) return;
    setDragging(false);
    pick(event.dataTransfer.files);
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <section className="card-soft overflow-hidden rounded-2xl">
        <div className="flex items-center justify-between gap-4 border-b border-[var(--color-line)] px-5 py-4 sm:px-7">
          <div className="flex items-center gap-3">
            <ChannelMark id="shopee" size={26} />
            <div>
              <p className="font-heading text-lg font-semibold text-[var(--color-ink)]">Planilha de embalagem</p>
              <p className="mt-1 text-sm text-[var(--color-muted)]">O Excel que a Shopee gera com produto, variação, SKU e quantidade.</p>
            </div>
          </div>
        </div>

        <div className="p-5 sm:p-7">
          {file ? (
            <div className="flex items-center gap-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-2)] px-4 py-3.5">
              <FileSpreadsheet size={20} className="shrink-0 text-uno-red" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-[var(--color-ink)]">{file.name}</span>
                <span className="block text-xs text-[var(--color-faint)]">{(file.size / 1024).toFixed(0)} KB</span>
              </span>
              <button type="button" onClick={reset} disabled={busy} className="grid size-8 shrink-0 place-items-center rounded-lg text-[var(--color-faint)] transition-colors hover:bg-[var(--hover-ink)] hover:text-uno-red disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-uno-red" aria-label="Remover planilha"><X size={16} /></button>
            </div>
          ) : (
            <div
              className={`grid min-h-64 place-items-center rounded-xl border border-dashed p-8 text-center transition-colors ${dragging ? "border-uno-red bg-uno-red/[.06]" : "border-[var(--color-line-strong)] bg-[var(--color-surface-2)] hover:border-uno-red/60"}`}
              onDragEnter={(event) => { event.preventDefault(); if (!busy) setDragging(true); }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
              onDrop={onDrop}
            >
              <div className="max-w-md">
                <span className="mx-auto grid size-12 place-items-center rounded-full border border-uno-red/20 bg-uno-red/10 text-uno-red"><UploadCloud size={22} /></span>
                <h2 className="mt-4 font-heading text-xl font-bold text-[var(--color-ink)]">Arraste a planilha aqui</h2>
                <p className="mt-2 text-sm leading-6 text-[var(--color-muted)]">Arquivo .xlsx da lista de embalagem, até 10 MB</p>
                <Button className="mt-4" onClick={() => inputRef.current?.click()}>Selecionar planilha</Button>
              </div>
            </div>
          )}

          {file ? (
            <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-[var(--color-line)] pt-5">
              <Button onClick={() => void generate()} disabled={busy}>
                {busy ? <LoaderCircle size={17} className="animate-spin motion-reduce:animate-none" /> : <Download size={17} />}
                Gerar lista
              </Button>
              <button type="button" onClick={reset} disabled={busy} className="text-sm font-medium text-[var(--color-muted)] underline-offset-4 hover:text-[var(--color-ink)] hover:underline disabled:opacity-40">Limpar</button>
            </div>
          ) : null}

          {error ? (
            <p role="alert" className="mt-4 flex items-start gap-2 text-sm font-medium leading-6 text-uno-red">
              <TriangleAlert size={17} className="mt-0.5 shrink-0" />{error}
            </p>
          ) : null}

          <input ref={inputRef} type="file" accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" className="sr-only" disabled={busy} onChange={(event) => pick(event.target.files)} aria-label="Selecionar planilha da Shopee" />
        </div>
      </section>

      <aside className="card-soft h-fit rounded-2xl p-5 sm:p-6" aria-label="Opções da lista">
        <p className="font-heading text-lg font-semibold text-[var(--color-ink)]">Opções</p>
        <p className="mt-2 text-sm leading-6 text-[var(--color-muted)]">A lista sai em PDF, pronta para imprimir.</p>

        <fieldset className="mt-5 border-t border-[var(--color-line)] pt-5" disabled={busy}>
          <legend className="text-xs font-semibold uppercase tracking-wide text-[var(--color-faint)]">Como agrupar</legend>
          <div className="mt-3 space-y-2">
            {ORDER_OPTIONS.map((item) => (
              <label key={item.id} className={`flex cursor-pointer gap-3 rounded-xl border px-3.5 py-2.5 transition-colors ${order === item.id ? "border-uno-red bg-uno-red/[.05]" : "border-[var(--color-line)] hover:border-uno-red/40"}`}>
                <input type="radio" name="order" value={item.id} checked={order === item.id} onChange={() => setOrder(item.id)} className="mt-0.5 size-4 accent-[#ef233c]" />
                <span>
                  <span className="block text-sm font-medium text-[var(--color-ink)]">{item.label}</span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-[var(--color-faint)]">{item.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="mt-6 border-t border-[var(--color-line)] pt-5" disabled={busy}>
          <legend className="text-xs font-semibold uppercase tracking-wide text-[var(--color-faint)]">Papel</legend>
          <div className="mt-3 flex gap-2">
            {(["a4", "10x15"] as Paper[]).map((value) => (
              <button key={value} type="button" onClick={() => setPaper(value)} aria-pressed={paper === value}
                className={`flex-1 rounded-xl border px-3 py-2 text-sm font-semibold transition-colors ${paper === value ? "border-uno-red bg-uno-red/[.06] text-[var(--color-ink)]" : "border-[var(--color-line)] text-[var(--color-muted)] hover:border-uno-red/40"}`}>
                {value === "a4" ? "A4" : "10 × 15"}
              </button>
            ))}
          </div>
          {paper === "a4" ? (
            <label className="mt-3 block text-xs text-[var(--color-muted)]">Pedidos por folha
              <select value={perPage} onChange={(event) => setPerPage(Number(event.currentTarget.value) as 15 | 30 | 50)}
                className="mt-2 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] px-3 py-2 text-sm text-[var(--color-ink)] outline-none focus:border-uno-red">
                <option value={15}>15 por folha</option>
                <option value={30}>30 por folha</option>
                <option value={50}>50 por folha</option>
              </select>
            </label>
          ) : null}
        </fieldset>

        <fieldset className="mt-6 border-t border-[var(--color-line)] pt-5" disabled={busy}>
          <legend className="text-xs font-semibold uppercase tracking-wide text-[var(--color-faint)]">Filtros</legend>
          <label className="mt-3 block text-xs text-[var(--color-muted)]">Setor (prefixo de SKU)
            <input value={sector} onChange={(event) => setSector(event.currentTarget.value)} placeholder="Ex.: CAM, CAN — vazio = tudo"
              className="mt-2 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] px-3 py-2 text-sm text-[var(--color-ink)] outline-none focus:border-uno-red" />
          </label>
          <label className="mt-4 flex cursor-pointer items-center gap-3">
            <input type="checkbox" checked={saleData} onChange={(event) => setSaleData(event.currentTarget.checked)} className="size-4 accent-[#ef233c]" />
            <span className="text-sm text-[var(--color-muted)]">Mostrar cliente e nº da venda</span>
          </label>
        </fieldset>

        <div className="mt-7 flex gap-3 border-t border-[var(--color-line)] pt-5 text-xs leading-5 text-[var(--color-muted)]">
          <ShieldCheck className="mt-0.5 shrink-0 text-uno-red" size={17} />
          <p>A planilha é lida na hora para desenhar a lista e descartada em seguida — nada é gravado nem entra na telemetria.</p>
        </div>
      </aside>
    </div>
  );
}
