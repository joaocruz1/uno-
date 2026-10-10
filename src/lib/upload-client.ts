/** Browser-side upload helpers: inspect a PDF, request a signed intent, and PUT
 * the bytes to private storage. Used by the marketplace lote flow; the single
 * conversion flow keeps its own copy to avoid coupling. */

export const PDF_CONTENT_TYPE = "application/pdf";

export type UploadIntent = {
  id: string;
  uploadUrl: string;
  headers: Record<string, string>;
  expiresAt: string;
};

export function isUploadIntent(value: unknown): value is UploadIntent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<UploadIntent>;
  return typeof candidate.id === "string"
    && typeof candidate.uploadUrl === "string"
    && typeof candidate.expiresAt === "string"
    && Boolean(candidate.headers) && typeof candidate.headers === "object" && !Array.isArray(candidate.headers)
    && Object.values(candidate.headers).every((header) => typeof header === "string");
}

export async function inspectPdf(file: File): Promise<{ checksumSha256?: string }> {
  const bytes = await file.arrayBuffer();
  const signature = new TextDecoder("ascii").decode(bytes.slice(0, 5));
  if (signature !== "%PDF-") throw new Error("O arquivo selecionado não possui uma assinatura PDF válida.");
  if (!globalThis.crypto?.subtle) return {};
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return { checksumSha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("") };
}

export async function requestUploadIntent(file: File, checksumSha256?: string): Promise<UploadIntent> {
  const response = await fetch("/api/dashboard/uploads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contentLength: file.size,
      contentType: PDF_CONTENT_TYPE,
      originalFileName: file.name,
      ...(checksumSha256 ? { checksumSha256 } : {}),
    }),
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Não foi possível preparar o upload.");
  }
  if (!response.ok) {
    const message = (body as { error?: { message?: string } })?.error?.message;
    throw new Error(message ?? "Não foi possível preparar o upload.");
  }
  if (!isUploadIntent(body)) throw new Error("O servidor retornou uma intenção de upload inválida.");
  return body;
}

export function putFile(
  intent: UploadIntent,
  file: File,
  onProgress: (value: number) => void,
  registerRequest: (request: XMLHttpRequest) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    registerRequest(request);
    request.open("PUT", intent.uploadUrl, true);
    request.timeout = 270_000;
    for (const [name, value] of Object.entries(intent.headers)) {
      if (name.toLowerCase() !== "content-length") request.setRequestHeader(name, value);
    }
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
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
