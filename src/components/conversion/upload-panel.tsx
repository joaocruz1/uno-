"use client";

import {
  CheckCircle2,
  FileText,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  UploadCloud,
  X,
} from "lucide-react";
import { useRef, useState, type DragEvent } from "react";

import { Button, Input, Progress } from "@/components/ui";
import { outputSizeSchema, type OutputSize } from "@/lib/label-size";
import { productHeaderSchema, type ProductHeader } from "@/lib/product-header";

const PDF_CONTENT_TYPE = "application/pdf";
const MEBIBYTE = 1_024 * 1_024;

type UploadPhase = "idle" | "preparing" | "requesting" | "uploading" | "uploaded" | "error";
type OutputPreset = "100x150" | "100x100" | "a6" | "custom";

type UploadIntent = {
  id: string;
  uploadUrl: string;
  headers: Record<string, string>;
  expiresAt: string;
};

type ErrorEnvelope = {
  error?: {
    message?: string;
  };
};

export type UploadedFile = {
  intentId: string;
  fileName: string;
  fileSize: number;
  checksumSha256?: string;
  output: OutputSize;
  product?: ProductHeader;
};

export type UploadPanelProps = {
  planName: string;
  maxFileMB: number;
  onUploaded?: (upload: UploadedFile) => void;
};

function formatBytes(bytes: number) {
  if (bytes < MEBIBYTE) return `${Math.max(1, Math.round(bytes / 1_024))} KB`;
  return `${(bytes / MEBIBYTE).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
}

function isUploadIntent(value: unknown): value is UploadIntent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<UploadIntent>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.uploadUrl === "string" &&
    typeof candidate.expiresAt === "string" &&
    Boolean(candidate.headers) &&
    typeof candidate.headers === "object" &&
    !Array.isArray(candidate.headers) &&
    Object.values(candidate.headers).every((header) => typeof header === "string")
  );
}

async function responseMessage(response: Response) {
  try {
    const body = (await response.json()) as ErrorEnvelope;
    return body.error?.message ?? "Não foi possível preparar o upload.";
  } catch {
    return "Não foi possível preparar o upload.";
  }
}

async function inspectPdf(file: File): Promise<{ checksumSha256?: string }> {
  const bytes = await file.arrayBuffer();
  const signature = new TextDecoder("ascii").decode(bytes.slice(0, 5));
  if (signature !== "%PDF-") throw new Error("O arquivo selecionado não possui uma assinatura PDF válida.");
  if (!globalThis.crypto?.subtle) return {};
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const checksumSha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { checksumSha256 };
}

function putFile(
  intent: UploadIntent,
  file: File,
  onProgress: (value: number) => void,
  registerRequest: (request: XMLHttpRequest) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    registerRequest(request);
    request.open("PUT", intent.uploadUrl, true);
    request.timeout = 270_000;

    for (const [name, value] of Object.entries(intent.headers)) {
      if (name.toLowerCase() !== "content-length") request.setRequestHeader(name, value);
    }

    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      }
    });
    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new Error("O armazenamento recusou o arquivo. Tente novamente."));
    });
    request.addEventListener("error", () => reject(new Error("A conexão foi interrompida durante o upload.")));
    request.addEventListener("timeout", () => reject(new Error("O tempo para envio expirou. Tente novamente.")));
    request.addEventListener("abort", () => reject(new Error("O upload foi cancelado.")));
    request.send(file);
  });
}

export function UploadPanel({ planName, maxFileMB, onUploaded }: UploadPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeRequestRef = useRef<XMLHttpRequest | null>(null);
  const operationRef = useRef(0);
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<UploadPhase>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<UploadedFile | null>(null);
  const [dragging, setDragging] = useState(false);
  const [preset, setPreset] = useState<OutputPreset>("100x150");
  const [customWidth, setCustomWidth] = useState("100");
  const [customHeight, setCustomHeight] = useState("150");
  const [productTitle, setProductTitle] = useState("");
  const [productSku, setProductSku] = useState("");
  const [productVariation, setProductVariation] = useState("");
  const [productQuantity, setProductQuantity] = useState("1");
  const busy = phase === "preparing" || phase === "requesting" || phase === "uploading";
  const maxBytes = maxFileMB * MEBIBYTE;

  const currentOutput = () => ({
    preset,
    ...(preset === "custom" ? { widthMm: Number(customWidth), heightMm: Number(customHeight) } : {}),
  });

  const reset = () => {
    operationRef.current += 1;
    activeRequestRef.current?.abort();
    activeRequestRef.current = null;
    setFile(null);
    setPhase("idle");
    setProgress(0);
    setError(null);
    setUploaded(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const upload = async (nextFile: File) => {
    const operation = operationRef.current + 1;
    operationRef.current = operation;
    activeRequestRef.current?.abort();
    activeRequestRef.current = null;
    setFile(nextFile);
    setUploaded(null);
    setError(null);
    setProgress(0);

    if (nextFile.size < 1) {
      setPhase("error");
      setError("O arquivo está vazio.");
      return;
    }
    if (nextFile.size > maxBytes) {
      setPhase("error");
      setError(`O arquivo excede o limite de ${maxFileMB} MB do plano ${planName}.`);
      return;
    }
    if (nextFile.type && nextFile.type !== PDF_CONTENT_TYPE) {
      setPhase("error");
      setError("Selecione um arquivo PDF.");
      return;
    }

    try {
      const chosenOutput = outputSizeSchema.safeParse(currentOutput());
      if (!chosenOutput.success) throw new Error("Informe largura entre 50 e 210 mm e altura entre 50 e 300 mm.");
      let chosenProduct: ProductHeader | undefined;
      if (productTitle.trim() || productSku.trim() || productVariation.trim()) {
        const parsedProduct = productHeaderSchema.safeParse({
          quantity: Number(productQuantity),
          title: productTitle,
          ...(productSku.trim() ? { sku: productSku } : {}),
          ...(productVariation.trim() ? { variation: productVariation } : {}),
        });
        if (!parsedProduct.success) throw new Error("Para imprimir o produto, informe o nome e uma quantidade de 1 a 9999.");
        chosenProduct = parsedProduct.data;
      }
      setPhase("preparing");
      const { checksumSha256 } = await inspectPdf(nextFile);
      if (operationRef.current !== operation) return;

      setPhase("requesting");
      const response = await fetch("/api/dashboard/uploads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contentLength: nextFile.size,
          contentType: PDF_CONTENT_TYPE,
          originalFileName: nextFile.name,
          ...(checksumSha256 ? { checksumSha256 } : {}),
        }),
      });
      if (!response.ok) throw new Error(await responseMessage(response));
      const intent: unknown = await response.json();
      if (!isUploadIntent(intent)) throw new Error("O servidor retornou uma intenção de upload inválida.");
      if (operationRef.current !== operation) return;

      setPhase("uploading");
      await putFile(intent, nextFile, setProgress, (request) => {
        activeRequestRef.current = request;
      });
      if (operationRef.current !== operation) return;

      const result: UploadedFile = {
        intentId: intent.id,
        fileName: nextFile.name,
        fileSize: nextFile.size,
        checksumSha256,
        output: chosenOutput.data,
        ...(chosenProduct ? { product: chosenProduct } : {}),
      };
      activeRequestRef.current = null;
      setProgress(100);
      setUploaded(result);
      setPhase("uploaded");
      onUploaded?.(result);
    } catch (cause) {
      if (operationRef.current !== operation) return;
      activeRequestRef.current = null;
      setPhase("error");
      setError(cause instanceof Error ? cause.message : "Não foi possível enviar o arquivo.");
    }
  };

  const receiveFiles = (files: FileList | null) => {
    const nextFile = files?.item(0);
    if (nextFile) void upload(nextFile);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (busy) return;
    setDragging(false);
    if (event.dataTransfer.files.length !== 1) {
      setPhase("error");
      setError("Envie um PDF por vez.");
      return;
    }
    receiveFiles(event.dataTransfer.files);
  };

  const phaseLabel = {
    idle: "Aguardando arquivo",
    preparing: "Verificando arquivo e calculando integridade",
    requesting: "Preparando upload privado",
    uploading: `Enviando arquivo · ${progress}%`,
    uploaded: "Arquivo enviado",
    error: "O upload precisa de atenção",
  }[phase];

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <section className="overflow-hidden rounded-2xl border border-white/[.08] bg-[#050505]">
        <div className="border-b border-white/[.07] px-5 py-4 sm:px-7">
          <p className="font-heading text-lg font-semibold">Arquivo de entrada</p>
          <p className="mt-1 text-sm text-zinc-500">Um PDF com a etiqueta logística e a DANFE.</p>
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
                <h2 className="mt-5 font-heading text-xl font-bold">Arraste seu PDF aqui</h2>
                <p className="mt-2 text-sm leading-6 text-zinc-500">Somente PDF · um arquivo · até {maxFileMB} MB no plano {planName}</p>
                <Button className="mt-6" onClick={() => fileInputRef.current?.click()}>Selecionar arquivo</Button>
              </div>
            </div>
          ) : (
            <div className="min-h-72 border border-white/[.08] bg-black p-5 sm:p-7">
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 gap-4">
                  <span className={`grid size-11 shrink-0 place-items-center rounded-full ${phase === "uploaded" ? "bg-emerald-400/10 text-emerald-400" : "bg-uno-red/10 text-uno-red"}`}>
                    {phase === "uploaded" ? <CheckCircle2 size={21} /> : <FileText size={21} />}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-white">{file?.name}</p>
                    <p className="mt-1 text-xs text-zinc-500">{file ? formatBytes(file.size) : null} · PDF</p>
                  </div>
                </div>
                <button type="button" onClick={reset} className="rounded-full p-2 text-zinc-500 hover:bg-white/[.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-uno-red" aria-label={busy ? "Cancelar upload" : "Limpar arquivo"}><X size={18} /></button>
              </div>

              <div className="mt-12" aria-live="polite" aria-atomic="true">
                <div className="flex items-center gap-2 text-sm font-medium">
                  {busy ? <RefreshCw className="animate-spin text-uno-red motion-reduce:animate-none" size={16} /> : null}
                  <span>{phaseLabel}</span>
                </div>
                {phase === "uploading" ? <Progress className="mt-4" value={progress} label="Progresso do envio" /> : null}
                {phase === "preparing" || phase === "requesting" ? <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/[.07]"><div className="h-full w-1/3 animate-pulse rounded-full bg-uno-red motion-reduce:animate-none" /></div> : null}
                {phase === "uploaded" && uploaded ? (
                  <div className="mt-5 grid gap-3 border-t border-white/[.07] pt-5 text-sm sm:grid-cols-2">
                    <div><p className="text-xs text-zinc-600">Tamanho</p><p className="mt-1 text-zinc-300">{formatBytes(uploaded.fileSize)}</p></div>
                    <div><p className="text-xs text-zinc-600">Formato escolhido</p><p className="mt-1 text-zinc-300">{preset === "a6" ? "A6" : preset === "custom" ? `${customWidth} × ${customHeight} mm` : `${preset.replace("x", " × ")} mm`}</p></div>
                  </div>
                ) : null}
                {phase === "error" && error ? <p className="mt-4 text-sm leading-6 text-red-300" role="alert">{error}</p> : null}
              </div>

              {phase === "error" && file ? (
                <div className="mt-7 flex flex-wrap gap-3">
                  <Button onClick={() => void upload(file)}><RotateCcw size={16} />Tentar novamente</Button>
                  <Button variant="secondary" onClick={reset}>Escolher outro arquivo</Button>
                </div>
              ) : null}
              {phase === "uploaded" ? <p className="mt-7 text-xs leading-5 text-zinc-600">O arquivo foi recebido com segurança.</p> : null}
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            className="sr-only"
            disabled={busy}
            onChange={(event) => receiveFiles(event.target.files)}
            aria-label="Selecionar arquivo PDF"
          />
        </div>
      </section>

      <aside className="rounded-2xl border border-white/[.08] bg-[#050505] p-5 sm:p-6" aria-label="Configuração da saída">
        <p className="font-heading text-lg font-semibold">Formato da etiqueta</p>
        <p className="mt-2 text-sm leading-6 text-zinc-500">Escolha a dimensão que será usada quando a conversão for criada.</p>
        <fieldset className="mt-6 space-y-2" disabled={busy || phase === "uploaded"}>
          <legend className="sr-only">Formato de saída</legend>
          {[
            ["100x150", "100 × 150 mm", "Padrão"],
            ["100x100", "100 × 100 mm", "Compacta"],
            ["a6", "A6", "105 × 148 mm"],
            ["custom", "Personalizado", "Defina as medidas"],
          ].map(([value, label, detail]) => (
            <label key={value} className={`flex cursor-pointer items-center justify-between gap-3 rounded-xl border p-3 transition-colors ${preset === value ? "border-uno-red/60 bg-uno-red/[.07]" : "border-white/[.08] bg-black hover:border-white/20"}`}>
              <span className="flex items-center gap-3">
                <input type="radio" name="output-size" value={value} checked={preset === value} onChange={() => setPreset(value as OutputPreset)} className="accent-[#ef233c]" />
                <span className="text-sm font-medium text-zinc-200">{label}</span>
              </span>
              <span className="text-[11px] text-zinc-600">{detail}</span>
            </label>
          ))}
        </fieldset>

        {preset === "custom" ? (
          <div className="mt-4 grid grid-cols-2 gap-3">
            <label className="text-xs text-zinc-500">Largura (mm)<Input className="mt-2" type="number" min={50} max={210} step={1} value={customWidth} disabled={busy || phase === "uploaded"} onChange={(event) => setCustomWidth(event.currentTarget.value)} /></label>
            <label className="text-xs text-zinc-500">Altura (mm)<Input className="mt-2" type="number" min={50} max={300} step={1} value={customHeight} disabled={busy || phase === "uploaded"} onChange={(event) => setCustomHeight(event.currentTarget.value)} /></label>
            <p className="col-span-2 text-[11px] leading-5 text-zinc-600">Largura de 50 a 210 mm e altura de 50 a 300 mm.</p>
          </div>
        ) : null}

        <fieldset className="mt-6 border-t border-white/[.07] pt-5" disabled={busy || phase === "uploaded"}>
          <legend className="font-heading text-sm font-semibold text-zinc-200">Produto no topo da etiqueta <span className="font-normal text-zinc-600">(opcional)</span></legend>
          <p className="mt-2 text-[11px] leading-5 text-zinc-600">Preencha antes de selecionar o PDF para imprimir quantidade, produto e SKU acima da etiqueta. O arquivo não traz esses dados.</p>
          <div className="mt-3 grid grid-cols-4 gap-3">
            <label className="col-span-3 text-xs text-zinc-500">Produto<Input className="mt-2" maxLength={140} value={productTitle} onChange={(event) => setProductTitle(event.currentTarget.value)} /></label>
            <label className="text-xs text-zinc-500">Qtd.<Input className="mt-2" type="number" min={1} max={9999} step={1} value={productQuantity} onChange={(event) => setProductQuantity(event.currentTarget.value)} /></label>
            <label className="col-span-2 text-xs text-zinc-500">SKU<Input className="mt-2" maxLength={60} value={productSku} onChange={(event) => setProductSku(event.currentTarget.value)} /></label>
            <label className="col-span-2 text-xs text-zinc-500">Variação<Input className="mt-2" maxLength={60} placeholder="Cor: Verde" value={productVariation} onChange={(event) => setProductVariation(event.currentTarget.value)} /></label>
          </div>
        </fieldset>

        <div className="mt-7 flex gap-3 border-t border-white/[.07] pt-5 text-xs leading-5 text-zinc-500">
          <ShieldCheck className="mt-0.5 shrink-0 text-uno-red" size={17} />
          <p>O upload vai direto para o armazenamento privado por uma URL temporária. O conteúdo do documento não é enviado à telemetria.</p>
        </div>
      </aside>
    </div>
  );
}
