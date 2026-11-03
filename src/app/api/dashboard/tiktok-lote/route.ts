import { AppError } from "@/lib/errors";
import { getPlanCatalog } from "@/lib/plans";
import { assertSameOrigin, errorResponse, requireActor } from "@/server/http";
import { MAX_LOTE_FILES } from "@/server/marketplace/create";
import { convertTikTokSync, pdfResponse, syncErrorResponse } from "@/server/marketplace/sync";

export const runtime = "nodejs";

const MEBIBYTE = 1_024 * 1_024;

async function readFiles(form: FormData, field: string, maxBytes: number, maxFileMB: number): Promise<Uint8Array[]> {
  const files = form.getAll(field).filter((entry): entry is File => entry instanceof File);
  const out: Uint8Array[] = [];
  for (const file of files) {
    if (file.size < 1) continue;
    if (file.size > maxBytes) throw new AppError("file_too_large", `Cada arquivo deve ter até ${maxFileMB} MB no plano atual.`, 413);
    out.push(new Uint8Array(await file.arrayBuffer()));
  }
  return out;
}

/**
 * Builds one print-ready PDF from TikTok's shipping-label PDF(s) and, optionally,
 * the NF-e PDF(s). Synchronous — pages are sliced and concatenated in memory,
 * nothing is stored. Counts come back in x-uno-* headers.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const actor = await requireActor(request.headers);
    const plan = getPlanCatalog()[actor.planId];
    const maxBytes = plan.maxFileMB * MEBIBYTE;

    const form = await request.formData();
    const labelFiles = await readFiles(form, "label", maxBytes, plan.maxFileMB);
    const nfeFiles = await readFiles(form, "nfe", maxBytes, plan.maxFileMB);
    if (labelFiles.length === 0) throw new AppError("invalid_request", "Envie ao menos um PDF de etiquetas do TikTok.", 400);
    if (labelFiles.length + nfeFiles.length > MAX_LOTE_FILES * 2) throw new AppError("invalid_request", "Arquivos demais no lote.", 400);

    return pdfResponse(await convertTikTokSync(labelFiles, nfeFiles));
  } catch (error) {
    return syncErrorResponse(error) ?? errorResponse(error);
  }
}
