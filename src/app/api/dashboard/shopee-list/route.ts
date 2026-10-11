import {
  buildPickingListPdf,
  createShopeeWorkbookReader,
  parseShopeePacking,
  ShopeeError,
  SHOPEE_MAX_BYTES,
  type ListOrder,
  type PickingListPaper,
} from "@/engine/marketplace";
import { AppError } from "@/lib/errors";
import { assertSameOrigin, errorResponse, requireActor } from "@/server/http";

export const runtime = "nodejs";

const ORDERS: Record<string, ListOrder> = { "por-pedido": "sequence", "agrupada": "group-sku", "soma": "sum-sku" };
const PAPERS: Record<string, PickingListPaper> = { "10x15": "10x15", "a4": "a4" };
const PER_PAGE: Record<string, 15 | 30 | 50> = { "15": 15, "30": 30, "50": 50 };

/**
 * Generates a Shopee separation list from an uploaded packing-list .xlsx and
 * returns it as a PDF. Synchronous and free: the spreadsheet is read, the items
 * are grouped, and the list is drawn in memory — nothing is stored or logged
 * (the buyer data only lands on the returned PDF).
 */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    await requireActor(request.headers);

    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength === 0) throw new AppError("invalid_request", "Envie a planilha da lista de embalagem.", 400);
    if (bytes.byteLength > SHOPEE_MAX_BYTES) throw new AppError("file_too_large", "A planilha excede o limite de tamanho.", 413);

    const params = new URL(request.url).searchParams;
    const order = ORDERS[params.get("order") ?? "soma"] ?? "sum-sku";
    const paper = PAPERS[params.get("paper") ?? "a4"] ?? "a4";
    const perPage = PER_PAGE[params.get("perPage") ?? "30"] ?? 30;
    const sector = (params.get("sector") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
    const showSaleData = params.get("saleData") === "1";

    const matrix = createShopeeWorkbookReader().read(bytes);
    const orders = parseShopeePacking(matrix);

    const pdf = await buildPickingListPdf(orders, {
      marketplaceLabel: "Shopee",
      order,
      paper,
      ...(paper === "a4" ? { perPage } : {}),
      showSaleData,
      ...(sector.length > 0 ? { sectorPrefixes: sector } : {}),
    });

    return new Response(Buffer.from(pdf), {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": 'attachment; filename="uno-lista-shopee.pdf"',
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof ShopeeError) {
      const status = error.code === "shopee_file_too_large" ? 413 : 422;
      return Response.json({ error: { code: error.code, message: error.message } }, { status });
    }
    return errorResponse(error);
  }
}
