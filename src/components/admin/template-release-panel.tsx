"use client";

import { useEffect, useRef, useState } from "react";

import { errorMessage, formatDateTime, RequestError, requestJson } from "@/components/settings/request";
import { Button, Dialog, EmptyState, Input, LoadingState } from "@/components/ui";
import { adminTemplateListSchema, physicalProofSchema, publishedReleaseSchema, type AdminTemplateList, type PhysicalProof } from "@/lib/admin-model";

const sectionClass = "rounded-2xl border border-white/10 bg-[#080808] p-6";
const selectClass = "h-11 w-full rounded-lg border border-white/10 bg-[#0d0d0d] px-3 text-sm text-white outline-none focus:border-uno-red/70 focus:ring-2 focus:ring-uno-red/20 disabled:opacity-50";
const fileClass = "mt-2 block w-full text-sm text-zinc-300 file:mr-4 file:rounded-full file:border-0 file:bg-white/[.08] file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-white/[.12]";
const MAX_FILE_BYTES = 200_000;
const STATUS_LABELS = { DRAFT: "Rascunho", RELEASED: "Liberado", RETIRED: "Aposentado" } as const;

type LoadedFile = { name: string; text: string };
type ProofPreview = { ok: true; proof: PhysicalProof } | { ok: false };

async function readJsonFile(file: File | undefined): Promise<LoadedFile | undefined> {
  if (!file) return undefined;
  if (file.size > MAX_FILE_BYTES) throw new Error("O arquivo excede 200 kB.");
  const text = await file.text();
  JSON.parse(text);
  return { name: file.name, text };
}

function previewProof(file: LoadedFile | undefined): ProofPreview | undefined {
  if (!file) return undefined;
  try {
    const value = JSON.parse(file.text) as Record<string, unknown>;
    const { approvedBy: _approvedBy, approvedAt: _approvedAt, ...record } = value;
    void _approvedBy; void _approvedAt;
    const parsed = physicalProofSchema.safeParse(record);
    return parsed.success ? { ok: true, proof: parsed.data } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function TemplateReleasePanel() {
  const [templates, setTemplates] = useState<AdminTemplateList>();
  const [loadError, setLoadError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [templateId, setTemplateId] = useState("");
  const [widthMm, setWidthMm] = useState("100");
  const [heightMm, setHeightMm] = useState("150");
  const [report, setReport] = useState<LoadedFile>();
  const [proof, setProof] = useState<LoadedFile>();
  const [attested, setAttested] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string; fields?: string[] }>();
  const lock = useRef(false);
  const reportInput = useRef<HTMLInputElement | null>(null);
  const proofInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      try {
        const body = adminTemplateListSchema.parse(await requestJson("/api/admin/templates", { signal: abort.signal }));
        if (!abort.signal.aborted) { setTemplates(body); setLoadError(undefined); }
      } catch (cause) {
        if (!abort.signal.aborted) setLoadError(errorMessage(cause, "Não foi possível consultar os modelos."));
      }
    })();
    return () => abort.abort();
  }, [refresh]);

  const releasable = templates?.items.filter((item) => item.recognizedByEngine && item.status !== "RETIRED") ?? [];
  const selectedId = templateId || releasable[0]?.id || "";
  const preview = previewProof(proof);
  const width = Number(widthMm);
  const height = Number(heightMm);
  const sizeValid = width >= 50 && width <= 210 && height >= 50 && height <= 300;
  const ready = Boolean(selectedId && report && proof && attested && sizeValid);

  const load = async (file: File | undefined, set: (value: LoadedFile | undefined) => void, label: string) => {
    setMessage(undefined);
    try {
      set(await readJsonFile(file));
    } catch (cause) {
      set(undefined);
      setMessage({ kind: "error", text: `${label}: ${cause instanceof Error && cause.message.startsWith("O arquivo") ? cause.message : "o arquivo não é um JSON válido."}` });
    }
  };

  const publish = async () => {
    setConfirming(false);
    if (!ready || !report || !proof || lock.current) return;
    lock.current = true; setBusy(true); setMessage(undefined);
    try {
      const published = publishedReleaseSchema.parse(await requestJson(`/api/admin/templates/${selectedId}/releases`, {
        method: "POST",
        body: { widthMm: width, heightMm: height, automaticReportJson: report.text, physicalProof: JSON.parse(proof.text) as unknown, attestation: { physicalProofPerformed: true } },
      }));
      setMessage({ kind: "ok", text: published.created ? `Combinação ${published.release.widthMm} × ${published.release.heightMm} mm liberada.` : "Esta combinação já estava liberada com a mesma evidência. Nada foi alterado." });
      setReport(undefined); setProof(undefined); setAttested(false);
      if (reportInput.current) reportInput.current.value = "";
      if (proofInput.current) proofInput.current.value = "";
      setRefresh((value) => value + 1);
    } catch (cause) {
      setMessage({ kind: "error", text: errorMessage(cause, "Não foi possível publicar a liberação."), fields: cause instanceof RequestError ? cause.fields : [] });
    } finally {
      lock.current = false; setBusy(false);
    }
  };

  return (
    <div className="mt-8 space-y-8">
      <section className={sectionClass} aria-labelledby="templates-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="templates-title" className="font-heading text-xl font-semibold">Modelos e combinações liberadas</h2>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRefresh((value) => value + 1)}>Atualizar</Button>
        </div>
        {loadError ? <p role="alert" className="mt-5 text-sm text-red-300">{loadError}</p> : !templates ? <LoadingState label="Consultando modelos" /> : !templates.items.length ? (
          <div className="mt-5"><EmptyState title="Nenhum modelo cadastrado" description="Os modelos são registrados pela engenharia junto com a versão da engine." /></div>
        ) : (
          <ul className="mt-5 space-y-4">
            {templates.items.map((item) => (
              <li key={item.id} className="rounded-xl border border-white/10 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm font-medium">{item.key}@{item.version} <span className="text-zinc-500">· engine {item.engineVersion}</span></p>
                  <p className="text-xs text-zinc-400">{STATUS_LABELS[item.status]}{item.recognizedByEngine ? "" : " · não reconhecido pela engine atual"}</p>
                </div>
                {item.releases.length ? (
                  <ul className="mt-3 space-y-2">
                    {item.releases.map((release) => <li key={release.id} className="text-xs text-zinc-400"><span className="text-white">{release.widthMm} × {release.heightMm} mm</span> · aprovada em {formatDateTime(release.approvedAt)} · evidência <span className="font-mono" title={release.evidenceSha256}>{release.evidenceSha256.slice(0, 12)}…</span></li>)}
                  </ul>
                ) : <p className="mt-3 text-xs text-zinc-500">Nenhuma combinação liberada.</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={sectionClass} aria-labelledby="release-title">
        <h2 id="release-title" className="font-heading text-xl font-semibold">Liberar uma combinação</h2>
        <p className="mt-2 max-w-2xl text-sm text-zinc-400">Envie os dois arquivos do ensaio. O servidor calcula os hashes, confere um registro contra o outro e recusa qualquer divergência. A aprovação vale apenas para o tamanho testado.</p>
        {templates && !releasable.length ? <p className="mt-5 text-sm text-zinc-500">Nenhum modelo reconhecido pela engine atual está disponível para liberação.</p> : (
          <form className="mt-6 space-y-5" onSubmit={(event) => { event.preventDefault(); if (ready) setConfirming(true); }}>
            <div className="grid gap-4 sm:grid-cols-3">
              <label className="text-sm text-zinc-400">Modelo
                <select className={`${selectClass} mt-2`} value={selectedId} disabled={busy || !templates} onChange={(event) => setTemplateId(event.target.value)}>
                  {releasable.map((item) => <option key={item.id} value={item.id}>{item.key}@{item.version}</option>)}
                </select>
              </label>
              <label className="text-sm text-zinc-400">Largura (mm)
                <Input className="mt-2" type="number" inputMode="decimal" min={50} max={210} step={0.01} required value={widthMm} disabled={busy} onChange={(event) => setWidthMm(event.target.value)} />
              </label>
              <label className="text-sm text-zinc-400">Altura (mm)
                <Input className="mt-2" type="number" inputMode="decimal" min={50} max={300} step={0.01} required value={heightMm} disabled={busy} onChange={(event) => setHeightMm(event.target.value)} />
              </label>
            </div>
            <label className="block text-sm text-zinc-400">Relatório automático (automatic.json, sem alterações)
              <input ref={reportInput} className={fileClass} type="file" accept="application/json,.json" disabled={busy} onChange={(event) => void load(event.target.files?.[0], setReport, "Relatório automático")} />
            </label>
            <label className="block text-sm text-zinc-400">Registro da prova física preenchido pelo operador (JSON)
              <input ref={proofInput} className={fileClass} type="file" accept="application/json,.json" disabled={busy} onChange={(event) => void load(event.target.files?.[0], setProof, "Registro da prova física")} />
            </label>

            {preview?.ok ? (
              <dl className="grid gap-x-6 gap-y-3 rounded-xl border border-white/10 p-4 text-sm sm:grid-cols-2">
                <div><dt className="text-xs text-zinc-500">Operador</dt><dd>{preview.proof.operator}</dd></div>
                <div><dt className="text-xs text-zinc-500">Ensaio em</dt><dd>{formatDateTime(preview.proof.testedAt)}</dd></div>
                <div><dt className="text-xs text-zinc-500">Impressora</dt><dd>{preview.proof.printer} · {preview.proof.dpi} dpi</dd></div>
                <div><dt className="text-xs text-zinc-500">Driver e configurações</dt><dd>{preview.proof.driver}</dd></div>
                <div><dt className="text-xs text-zinc-500">Escala</dt><dd>{preview.proof.scalePercent}%</dd></div>
                <div><dt className="text-xs text-zinc-500">Medida da página</dt><dd>{preview.proof.measuredWidthMm} × {preview.proof.measuredHeightMm} mm (tolerância ±{preview.proof.acceptedDimensionToleranceMm} mm)</dd></div>
                <div><dt className="text-xs text-zinc-500">Leitor</dt><dd>{preview.proof.scanner}</dd></div>
                <div><dt className="text-xs text-zinc-500">Códigos lidos</dt><dd>{preview.proof.codes.length} códigos, 3 leituras cada</dd></div>
              </dl>
            ) : preview ? <p role="alert" className="text-sm text-red-300">O registro da prova física está incompleto. Todos os campos do protocolo precisam estar preenchidos, com escala 100%, sem cortes, conteúdo preservado e três leituras por código.</p> : null}

            <label className="flex items-start gap-3 text-sm text-zinc-300">
              <input type="checkbox" className="mt-1 accent-uno-red" checked={attested} disabled={busy} onChange={(event) => setAttested(event.target.checked)} />
              <span>Atesto que revisei a evidência e que esta prova física foi realmente realizada, na impressora e no tamanho informados.</span>
            </label>

            {message ? (
              <div role={message.kind === "error" ? "alert" : "status"} className={`text-sm ${message.kind === "error" ? "text-red-300" : "text-emerald-300"}`}>
                <p>{message.text}</p>
                {message.fields?.length ? <ul className="mt-2 list-disc space-y-1 pl-5 font-mono text-xs">{message.fields.map((field) => <li key={field}>{field}</li>)}</ul> : null}
              </div>
            ) : null}
            <Button type="submit" disabled={busy || !ready}>{busy ? "Publicando…" : "Liberar combinação…"}</Button>
          </form>
        )}
      </section>

      <Dialog open={confirming} onClose={() => setConfirming(false)} onConfirm={() => void publish()} title="Liberar esta combinação?" description={`O modelo passa a aceitar conversões em ${widthMm} × ${heightMm} mm em produção. A liberação fica registrada em seu nome e não pode ser substituída por outra evidência.`} confirmLabel="Liberar em produção" />
    </div>
  );
}
