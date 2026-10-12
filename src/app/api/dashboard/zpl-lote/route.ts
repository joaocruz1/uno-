import { convertFullMlBatch, DEFAULT_ZPL_LIMITS, type LabelNumbering, ZplError } from "@/engine/marketplace";
import { AppError } from "@/lib/errors";
import { assertSameOrigin, errorResponse, requireActor } from "@/server/http";

export const runtime = "nodejs";

const MAX_BYTES = DEFAULT_ZPL_LIMITS.maxBytes;
const SYNC_MAX_LABELS = 200;

function intParam(value: string | null, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

/**
 * Converts a Mercado Livre Full ZPL (pasted or a .zpl/.txt file, sent as the
 * request body) into one print-ready 10×15 PDF. Synchronous: each label is
 * redrawn as a vector PDF in memory and its barcode is validated — nothing is
 * stored and no external renderer is used. Numbering comes from the query.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    await requireActor(request.headers);

    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BYTES) throw new AppError("file_too_large", "O ZPL excede o limite de tamanho.", 413);
    const zpl = await request.text();
    if (zpl.length === 0) throw new AppError("invalid_request", "Cole o ZPL ou envie um arquivo .zpl/.txt.", 400);
    if (Buffer.byteLength(zpl, "utf8") > MAX_BYTES) throw new AppError("file_too_large", "O ZPL excede o limite de tamanho.", 413);

    const params = new URL(request.url).searchParams;
    let numbering: LabelNumbering | undefined;
    if (params.get("numerar") === "1") {
      const letter = (params.get("letra") ?? "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3);
      numbering = { ...(letter ? { letter } : {}), start: intParam(params.get("inicio"), 1, 99_999, 1), showTotal: params.get("total") !== "0" };
    }

    const result = await convertFullMlBatch(zpl, { numbering, maxLabels: SYNC_MAX_LABELS });

    return new Response(Buffer.from(result.bytes), {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": 'attachment; filename="uno-lote-full-ml.pdf"',
        "cache-control": "no-store",
        "x-uno-orders": String(result.orderCount),
        "x-uno-succeeded": String(result.succeeded),
        "x-uno-failed": String(result.failed),
      },
    });
  } catch (error) {
    if (error instanceof ZplError) {
      const status = error.code === "zpl_too_large" ? 413 : 422;
      return Response.json({ error: { code: error.code, message: error.message } }, { status });
    }
    return errorResponse(error);
  }
}
