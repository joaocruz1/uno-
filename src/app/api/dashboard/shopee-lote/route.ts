import { convertShopeeBatch, MarketplaceError, type LabelNumbering } from "@/engine/marketplace";
import { AppError } from "@/lib/errors";
import { getPlanCatalog } from "@/lib/plans";
import { assertSameOrigin, errorResponse, requireActor } from "@/server/http";
import { MAX_LOTE_FILES } from "@/server/marketplace/create";

export const runtime = "nodejs";

const MEBIBYTE = 1_024 * 1_024;
// v1 is a synchronous, unmetered utility (like the Shopee list): a fixed safety
// ceiling bounds the work per request. When it moves to the metered worker path
// it will use the plan's batch limit instead.
const SYNC_MAX_ORDERS = 100;

function intParam(value: string | null, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

/**
 * Converts Shopee label PDFs (N orders) into one print-ready 10×15 PDF and
 * returns it directly. Synchronous: each page is passed through byte-for-byte
 * after the engine proves it is 10×15 and its barcode still decodes, so nothing
 * is stored and the barcodes are preserved. Numbering comes from the query.
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

    const params = new URL(request.url).searchParams;
    let numbering: LabelNumbering | undefined;
    if (params.get("numerar") === "1") {
      const letter = (params.get("letra") ?? "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3);
      numbering = { ...(letter ? { letter } : {}), start: intParam(params.get("inicio"), 1, 99_999, 1), showTotal: params.get("total") !== "0" };
    }

    const result = await convertShopeeBatch(inputs, { numbering, maxOrders: SYNC_MAX_ORDERS });

    return new Response(Buffer.from(result.bytes), {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": 'attachment; filename="uno-lote-shopee.pdf"',
        "cache-control": "no-store",
        "x-uno-orders": String(result.orderCount),
        "x-uno-succeeded": String(result.succeeded),
        "x-uno-failed": String(result.failed),
      },
    });
  } catch (error) {
    if (error instanceof MarketplaceError) {
      const status = error.code === "too_many_orders" ? 413 : 422;
      return Response.json({ error: { code: error.code, message: error.message } }, { status });
    }
    return errorResponse(error);
  }
}
