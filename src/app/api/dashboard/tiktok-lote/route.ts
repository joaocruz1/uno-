import {
  combineInterleaved,
  createTikTokDocumentExtractor,
  type InvoiceUnit,
  type LabelUnit,
  planInterleave,
  TikTokError,
} from "@/engine/marketplace";
import { AppError } from "@/lib/errors";
import { getPlanCatalog } from "@/lib/plans";
import { assertSameOrigin, errorResponse, requireActor } from "@/server/http";
import { MAX_LOTE_FILES } from "@/server/marketplace/create";

export const runtime = "nodejs";

const MEBIBYTE = 1_024 * 1_024;
// v1 is a synchronous, unmetered utility (like the Shopee lote): a fixed ceiling
// bounds the work per request until it moves to the metered worker path.
const SYNC_MAX_ORDERS = 100;

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
 * the NF-e PDF(s): each label is followed by its matching invoice (paired by the
 * TikTok order number read off both). Synchronous — pages are sliced and
 * concatenated in memory, nothing is stored. Counts come back in x-uno-* headers.
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

    const extractor = createTikTokDocumentExtractor();
    const labels: LabelUnit[] = [];
    for (const bytes of labelFiles) labels.push(...(await extractor.extractLabels(bytes)));
    const invoices: InvoiceUnit[] = [];
    for (const bytes of nfeFiles) invoices.push(...(await extractor.extractInvoices(bytes)));

    if (labels.length === 0) throw new TikTokError("tiktok_no_labels");
    if (labels.length > SYNC_MAX_ORDERS) throw new AppError("batch_limit_exceeded", `O lote tem ${labels.length} pedidos; o limite é ${SYNC_MAX_ORDERS}.`, 413);

    const result = planInterleave(labels, invoices);
    const bytes = await combineInterleaved(result);

    return new Response(Buffer.from(bytes), {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": 'attachment; filename="uno-lote-tiktok.pdf"',
        "cache-control": "no-store",
        "x-uno-orders": String(labels.length),
        "x-uno-matched": String(labels.length - result.unmatchedLabels.length),
        "x-uno-unmatched-labels": String(result.unmatchedLabels.length),
        "x-uno-unmatched-invoices": String(result.unmatchedInvoices.length),
      },
    });
  } catch (error) {
    if (error instanceof TikTokError) {
      return Response.json({ error: { code: error.code, message: error.message } }, { status: 422 });
    }
    return errorResponse(error);
  }
}
