import { AppError } from "@/lib/errors";
import { getPlanCatalog } from "@/lib/plans";
import { assertSameOrigin, errorResponse, requireActor } from "@/server/http";
import { MAX_LOTE_FILES } from "@/server/marketplace/create";
import { convertShopeeSync, numberingFromQuery, pdfResponse, syncErrorResponse } from "@/server/marketplace/sync";

export const runtime = "nodejs";

const MEBIBYTE = 1_024 * 1_024;

/**
 * Converts Shopee label PDFs (N orders) into one print-ready 10×15 PDF and
 * returns it directly. Synchronous and unmetered; nothing is stored. Numbering
 * comes from the query.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const actor = await requireActor(request.headers);
    const plan = getPlanCatalog()[actor.planId];
    const maxBytes = plan.maxFileMB * MEBIBYTE;

    const form = await request.formData();
    const files = form.getAll("file").filter((entry): entry is File => entry instanceof File);
    if (files.length === 0) throw new AppError("invalid_request", "Envie ao menos um PDF de etiquetas da Shopee.", 400);
    if (files.length > MAX_LOTE_FILES) throw new AppError("invalid_request", `Máximo de ${MAX_LOTE_FILES} arquivos por lote.`, 400);

    const inputs: Uint8Array[] = [];
    for (const file of files) {
      if (file.size < 1) throw new AppError("invalid_request", "Um dos arquivos está vazio.", 400);
      if (file.size > maxBytes) throw new AppError("file_too_large", `Cada arquivo deve ter até ${plan.maxFileMB} MB no plano atual.`, 413);
      inputs.push(new Uint8Array(await file.arrayBuffer()));
    }

    return pdfResponse(await convertShopeeSync(inputs, numberingFromQuery(new URL(request.url).searchParams)));
  } catch (error) {
    return syncErrorResponse(error) ?? errorResponse(error);
  }
}
