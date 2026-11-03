import { AppError } from "@/lib/errors";
import { assertSameOrigin, errorResponse, requireActor } from "@/server/http";
import { convertZplSync, numberingFromQuery, pdfResponse, syncErrorResponse, ZPL_MAX_BYTES } from "@/server/marketplace/sync";

export const runtime = "nodejs";

/**
 * Converts a Mercado Livre Full ZPL (pasted or a .zpl/.txt file, sent as the
 * request body) into one print-ready 10×15 PDF. Synchronous; nothing is stored.
 * Numbering comes from the query.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    await requireActor(request.headers);

    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > ZPL_MAX_BYTES) throw new AppError("file_too_large", "O ZPL excede o limite de tamanho.", 413);
    const zpl = await request.text();

    return pdfResponse(await convertZplSync(zpl, numberingFromQuery(new URL(request.url).searchParams)));
  } catch (error) {
    return syncErrorResponse(error) ?? errorResponse(error);
  }
}
