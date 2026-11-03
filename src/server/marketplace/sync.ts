import {
  combineInterleaved,
  convertFullMlBatch,
  convertShopeeBatch,
  createTikTokDocumentExtractor,
  DEFAULT_ZPL_LIMITS,
  type InvoiceUnit,
  type LabelNumbering,
  type LabelUnit,
  MarketplaceError,
  planInterleave,
  TikTokError,
  ZplError,
} from "@/engine/marketplace";
import { AppError } from "@/lib/errors";

// The synchronous utilities are unmetered: a fixed safety ceiling bounds the
// work per request. When they move to the metered worker path they will use the
// plan's batch limit instead.
const SYNC_MAX_ORDERS = 100;
const SYNC_MAX_LABELS = 200;
export const ZPL_MAX_BYTES = DEFAULT_ZPL_LIMITS.maxBytes;

export type SyncResult = { bytes: Uint8Array; fileName: string; headers: Record<string, string> };

function intParam(value: string | null, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

/** Reads the dashboard's numbering query (`numerar`, `letra`, `inicio`, `total`). */
export function numberingFromQuery(params: URLSearchParams): LabelNumbering | undefined {
  if (params.get("numerar") !== "1") return undefined;
  const letter = (params.get("letra") ?? "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3);
  return { ...(letter ? { letter } : {}), start: intParam(params.get("inicio"), 1, 99_999, 1), showTotal: params.get("total") !== "0" };
}

/** Maps the engines' typed refusals to the HTTP envelope; anything else is rethrown. */
export function syncErrorResponse(error: unknown): Response | undefined {
  if (error instanceof MarketplaceError) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: error.code === "too_many_orders" ? 413 : 422 });
  }
  if (error instanceof ZplError) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: error.code === "zpl_too_large" ? 413 : 422 });
  }
  if (error instanceof TikTokError) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: 422 });
  }
  return undefined;
}

export function pdfResponse(result: SyncResult): Response {
  return new Response(Buffer.from(result.bytes), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${result.fileName}"`,
      "cache-control": "no-store",
      ...result.headers,
    },
  });
}

/**
 * Shopee label PDFs (N orders) → one print-ready 10×15 PDF. Each page is passed
 * through byte-for-byte after the engine proves it is 10×15 and its barcode
 * still decodes, so nothing is stored and the barcodes are preserved.
 */
export async function convertShopeeSync(inputs: Uint8Array[], numbering?: LabelNumbering): Promise<SyncResult> {
  const result = await convertShopeeBatch(inputs, { numbering, maxOrders: SYNC_MAX_ORDERS });
  return {
    bytes: result.bytes,
    fileName: "uno-lote-shopee.pdf",
    headers: {
      "x-uno-orders": String(result.orderCount),
      "x-uno-succeeded": String(result.succeeded),
      "x-uno-failed": String(result.failed),
    },
  };
}

/**
 * TikTok label PDF(s) and, optionally, NF-e PDF(s) → one PDF where each label is
 * followed by its matching invoice (paired by the order number read off both).
 */
export async function convertTikTokSync(labelFiles: Uint8Array[], nfeFiles: Uint8Array[]): Promise<SyncResult> {
  const extractor = createTikTokDocumentExtractor();
  const labels: LabelUnit[] = [];
  for (const bytes of labelFiles) labels.push(...(await extractor.extractLabels(bytes)));
  const invoices: InvoiceUnit[] = [];
  for (const bytes of nfeFiles) invoices.push(...(await extractor.extractInvoices(bytes)));

  if (labels.length === 0) throw new TikTokError("tiktok_no_labels");
  if (labels.length > SYNC_MAX_ORDERS) throw new AppError("batch_limit_exceeded", `O lote tem ${labels.length} pedidos; o limite é ${SYNC_MAX_ORDERS}.`, 413);

  const result = planInterleave(labels, invoices);
  const bytes = await combineInterleaved(result);
  return {
    bytes,
    fileName: "uno-lote-tiktok.pdf",
    headers: {
      "x-uno-orders": String(labels.length),
      "x-uno-matched": String(labels.length - result.unmatchedLabels.length),
      "x-uno-unmatched-labels": String(result.unmatchedLabels.length),
      "x-uno-unmatched-invoices": String(result.unmatchedInvoices.length),
    },
  };
}

/**
 * Mercado Livre Full ZPL → one print-ready 10×15 PDF. Each label is redrawn as
 * a vector PDF in memory and its barcode is validated; no external renderer.
 */
export async function convertZplSync(zpl: string, numbering?: LabelNumbering): Promise<SyncResult> {
  if (zpl.length === 0) throw new AppError("invalid_request", "Cole o ZPL ou envie um arquivo .zpl/.txt.", 400);
  if (Buffer.byteLength(zpl, "utf8") > ZPL_MAX_BYTES) throw new AppError("file_too_large", "O ZPL excede o limite de tamanho.", 413);
  const result = await convertFullMlBatch(zpl, { numbering, maxLabels: SYNC_MAX_LABELS });
  return {
    bytes: result.bytes,
    fileName: "uno-lote-full-ml.pdf",
    headers: {
      "x-uno-orders": String(result.orderCount),
      "x-uno-succeeded": String(result.succeeded),
      "x-uno-failed": String(result.failed),
    },
  };
}
