"use client";

import { CheckCircle2, Download, LoaderCircle, ShieldCheck, TriangleAlert, Upload } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui";
import { ChannelMark } from "@/components/marketplace-logos";

const MAX_BYTES = 4 * 1_024 * 1_024;

function safeMessage(value: unknown, fallback: string): string {
  const body = value as { error?: { message?: unknown } } | null;
  return typeof body?.error?.message === "string" ? body.error.message : fallback;
}

type Done = { orders: number; succeeded: number; failed: number };

export function FullMlFlow() {
  const [zpl, setZpl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<Done>();

  const [numerar, setNumerar] = useState(true);
  const [letra, setLetra] = useState("");
  const [inicio, setInicio] = useState("1");
  const [mostrarTotal, setMostrarTotal] = useState(true);

  const inputRef = useRef<HTMLInputElement>(null);

  const reset = () => { setZpl(""); setError(undefined); setDone(undefined); setBusy(false); if (inputRef.current) inputRef.current.value = ""; };

  const pickFile = async (file: File | undefined) => {
    if (!file || busy) return;
    if (file.size > MAX_BYTES) { setError("O arquivo excede 4 MB."); return; }
    setError(undefined);
    setZpl(await file.text());
    if (inputRef.current) inputRef.current.value = "";
  };

  const convert = async () => {
    const content = zpl.trim();
    if (!content || busy) return;
    setBusy(true); setError(undefined); setDone(undefined);
    let objectUrl: string | undefined;
    try {
      const start = Number(inicio);
      const params = new URLSearchParams({
        numerar: numerar ? "1" : "0",
        ...(numerar && letra ? { letra } : {}),
        inicio: Number.isInteger(start) && start >= 1 ? String(start) : "1",
        total: mostrarTotal ? "1" : "0",
      });
      const response = await fetch(`/api/dashboard/zpl-lote?${params}`, {
        method: "POST", headers: { "content-type": "text/plain; charset=utf-8" }, body: content, cache: "no-store",
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        throw new Error(safeMessage(body, "Não foi possível montar o lote."));
      }
      const num = (header: string) => Number(response.headers.get(header) ?? 0);
      objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = objectUrl; link.download = "uno-lote-full-ml.pdf";
      document.body.appendChild(link); link.click(); link.remove();
      setDone({ orders: num("x-uno-orders"), succeeded: num("x-uno-succeeded"), failed: num("x-uno-failed") });
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
          <ChannelMark id="mercado-livre" size={24} />
          <div>
            <p className="font-heading text-lg font-semibold text-[var(--color-ink)]">Etiqueta Full (ZPL)</p>
            <p className="mt-1 text-sm text-[var(--color-muted)]">Cole o ZPL do Full do Mercado Livre ou envie um arquivo .zpl/.txt.</p>
          </div>
        </div>

        <div className="p-5 sm:p-7">
          {done ? (
            <div className="rounded-xl border border-[var(--color-ok)]/30 bg-[var(--color-ok-surface)] p-5">
              <div className="flex items-center gap-3"><CheckCircle2 className="shrink-0 text-[var(--color-ok)]" size={20} /><h3 className="font-heading font-semibold text-[var(--color-ink)]">PDF do lote pronto</h3></div>
              <p className="mt-2 text-sm text-[var(--color-muted)]">{done.succeeded} etiqueta{done.succeeded === 1 ? "" : "s"} 10×15{done.failed > 0 ? ` · ${done.failed} não passou na validação e ficou de fora` : ""}.</p>
              <div className="mt-5"><Button variant="secondary" onClick={reset}>Novo lote</Button></div>
              <p className="mt-5 text-xs leading-5 text-[var(--color-muted)]">Imprima em tamanho real (100%). Confira a leitura dos códigos na sua térmica.</p>
            </div>
          ) : (
            <div className="space-y-4">
              <textarea
                value={zpl}
                onChange={(event) => setZpl(event.target.value)}
                disabled={busy}
                spellCheck={false}
                placeholder={"^XA\n^FO40,40^A0N,40,40^FDMERCADO LIVRE FULL^FS\n^FO40,100^BY3^BCN,160,Y,N,N^FD7899000000000^FS\n^XZ"}
                className="h-56 w-full resize-y rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-2)] p-4 font-mono text-xs leading-5 text-[var(--color-ink)] outline-none focus:border-uno-red"
                aria-label="ZPL do Full do Mercado Livre"
              />
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={() => void convert()} disabled={busy || zpl.trim().length === 0}>{busy ? <LoaderCircle size={17} className="animate-spin motion-reduce:animate-none" /> : <Download size={17} />}Montar lote</Button>
                <Button variant="secondary" onClick={() => inputRef.current?.click()} disabled={busy}><Upload size={16} />Enviar .zpl/.txt</Button>
                {zpl.trim() ? <button type="button" onClick={reset} disabled={busy} className="text-sm font-medium text-[var(--color-muted)] underline-offset-4 hover:text-[var(--color-ink)] hover:underline disabled:opacity-40">Limpar</button> : null}
                {busy ? <span className="text-xs text-[var(--color-muted)]">Renderizando e validando os códigos…</span> : null}
              </div>
              {error ? <p role="alert" className="flex items-start gap-2 text-sm font-medium leading-6 text-uno-red"><TriangleAlert size={17} className="mt-0.5 shrink-0" />{error}</p> : null}
            </div>
          )}
          <input ref={inputRef} type="file" accept=".zpl,.txt,text/plain" className="sr-only" disabled={busy} onChange={(event) => void pickFile(event.target.files?.[0] ?? undefined)} aria-label="Enviar arquivo ZPL" />
        </div>
      </section>

      <aside className="card-soft h-fit rounded-2xl p-5 sm:p-6" aria-label="Opções do lote">
        <div className="flex items-center gap-3 rounded-xl border border-uno-red/30 bg-uno-red/[.05] px-4 py-3">
          <ChannelMark id="mercado-livre" size={34} />
          <div>
            <p className="text-sm font-semibold text-[var(--color-ink)]">Full ML · ZPL</p>
            <p className="mt-0.5 text-[11px] text-[var(--color-muted)]">Cada etiqueta 10×15, com o código conferido.</p>
          </div>
        </div>

        <fieldset className="mt-6 border-t border-[var(--color-line)] pt-5" disabled={busy}>
          <label className="flex cursor-pointer items-center gap-3">
            <input type="checkbox" checked={numerar} onChange={(event) => setNumerar(event.currentTarget.checked)} className="size-4 accent-[#ef233c]" />
            <span className="text-sm font-medium text-[var(--color-ink)]">Numerar etiquetas</span>
          </label>
          {numerar ? (
            <div className="mt-4 grid grid-cols-2 gap-3">
              <label className="text-xs text-[var(--color-muted)]">Letra do lote
                <input className="mt-2 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] px-3 py-2 text-sm text-[var(--color-ink)] outline-none focus:border-uno-red" placeholder="—" maxLength={3} value={letra} onChange={(event) => setLetra(event.currentTarget.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3))} />
              </label>
              <label className="text-xs text-[var(--color-muted)]">Começar em
                <input className="mt-2 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] px-3 py-2 text-sm text-[var(--color-ink)] outline-none focus:border-uno-red" type="number" min={1} max={99999} value={inicio} onChange={(event) => setInicio(event.currentTarget.value)} />
              </label>
              <label className="col-span-2 flex cursor-pointer items-center gap-3 pt-1">
                <input type="checkbox" checked={mostrarTotal} onChange={(event) => setMostrarTotal(event.currentTarget.checked)} className="size-4 accent-[#ef233c]" />
                <span className="text-xs text-[var(--color-muted)]">Mostrar o total ao lado</span>
              </label>
            </div>
          ) : null}
        </fieldset>

        <div className="mt-7 flex gap-3 border-t border-[var(--color-line)] pt-5 text-xs leading-5 text-[var(--color-muted)]">
          <ShieldCheck className="mt-0.5 shrink-0 text-uno-red" size={17} />
          <p>O ZPL é renderizado aqui (sem serviço externo) e cada código de barras é conferido antes de entrar no PDF. Cobre o Full do ML (texto, caixas e Code128).</p>
        </div>
      </aside>
    </div>
  );
}
