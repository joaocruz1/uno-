import { PDFDocument } from "pdf-lib";

import { decodeCode } from "../barcodes";
import { openPdfRenderer } from "../render";
import { MarketplaceError } from "./errors";
import { concatPdfs, splitIntoOrderPdfs, stampTopLeftNumber } from "./pdf";
import type { MarketplaceBatchOptions, MarketplaceBatchResult, OrderOutcome } from "./types";

/** Shopee prints one finished 10×15 label per order — no fiscal page to fuse. */
const SHOPEE_PAGES_PER_ORDER = 1;
const DEFAULT_MAX_ORDERS = 500;

/** 100 × 150 mm in PDF points, and how far an order may stray before it is
 * treated as a format we do not handle yet (an A4 sheet, a ZPL render, …). */
const LABEL_WIDTH_PT = 283.465;
const LABEL_HEIGHT_PT = 425.197;
const SIZE_TOLERANCE = 0.08;

function isTenByFifteen(width: number, height: number): boolean {
  const near = (value: number, target: number) => Math.abs(value - target) / target <= SIZE_TOLERANCE;
  return near(width, LABEL_WIDTH_PT) && near(height, LABEL_HEIGHT_PT);
}

/**
 * Decodes the tracking Code128 of a one-page Shopee label, proving the barcode
 * still scans at both print densities before the label is admitted. Returns the
 * tracking text, or null when no readable Code128 is found at 203 or 300 dpi.
 * Runs inside the isolated engine process; the decoded value is only used to
 * admit the label and is never persisted (specs/.../pdf-engine-v1.md).
 */
export async function readShopeeBarcode(pageBytes: Uint8Array): Promise<string | null> {
  const renderer = await openPdfRenderer(pageBytes);
  try {
    for (const dpi of [203, 300]) {
      const bitmap = await renderer.render(1, dpi, 0, {});
      try {
        return decodeCode(bitmap, { x: 0, y: 0, width: bitmap.width, height: bitmap.height }, "CODE_128");
      } catch {
        // Try the next density before giving up on this label.
      }
    }
    return null;
  } finally {
    await renderer.close();
  }
}

/** Validates one order's label; returns the tracking on success or null to reject. */
export type ShopeeOrderValidator = (pageBytes: Uint8Array) => Promise<string | null>;

export type ShopeeBatchOptions = MarketplaceBatchOptions & {
  /** How each order's barcode is checked. Defaults to the render-based reader
   * ({@link readShopeeBarcode}); pass `null` to skip (size guard only), or a
   * stub to avoid rendering in tests. */
  validateOrder?: ShopeeOrderValidator | null;
};

/**
 * Converts a Shopee label PDF holding N orders into one print-ready 10×15 PDF.
 *
 * Unlike Mercado Livre, the Shopee label already arrives as a finished 10×15
 * page, so there is nothing to fuse: each order is passed through byte-for-byte
 * (its barcode is therefore preserved by construction) after two checks that
 * honour "recusa em vez de arriscar" (CLAUDE.md) — the page must be 10×15, and
 * its tracking barcode must still decode. An order that fails either check is
 * recorded and skipped, never failing the whole lote. Numbering is stamped per
 * position and the admitted labels are concatenated in order.
 *
 * Several files are concatenated first (the vendor may drop more than one
 * export), so the output follows the caller's upload order.
 */
export async function convertShopeeBatch(
  input: Uint8Array | readonly Uint8Array[],
  options: ShopeeBatchOptions = {},
): Promise<MarketplaceBatchResult> {
  const maxOrders = options.maxOrders ?? DEFAULT_MAX_ORDERS;
  const validate = options.validateOrder === undefined ? readShopeeBarcode : options.validateOrder;

  const files = Array.isArray(input) ? input : [input as Uint8Array];
  if (files.length === 0) throw new MarketplaceError("empty_document");
  const combined = files.length === 1 ? files[0] : await concatPdfs(files);
  const slices = await splitIntoOrderPdfs(combined, SHOPEE_PAGES_PER_ORDER);
  if (slices.length > maxOrders) {
    throw new MarketplaceError("too_many_orders", `O arquivo tem ${slices.length} pedidos; o limite por lote é ${maxOrders}.`);
  }

  const admitted: Uint8Array[] = [];
  const outcomes: OrderOutcome[] = [];
  for (let index = 0; index < slices.length; index += 1) {
    try {
      const doc = await PDFDocument.load(slices[index], { updateMetadata: false });
      const { width, height } = doc.getPage(0).getSize();
      if (!isTenByFifteen(width, height)) {
        outcomes.push({ index, ok: false, errorCode: "unexpected_label_size", errorMessage: "A etiqueta não está no tamanho 10×15 esperado da Shopee." });
        continue;
      }
      if (validate && !(await validate(slices[index]))) {
        outcomes.push({ index, ok: false, errorCode: "barcode_unreadable", errorMessage: "O código de barras da etiqueta não pôde ser lido." });
        continue;
      }
      admitted.push(slices[index]);
      outcomes.push({ index, ok: true });
    } catch (error) {
      outcomes.push({ index, ok: false, errorCode: "order_failed", errorMessage: error instanceof Error ? error.message : "Falha ao processar a etiqueta." });
    }
  }
  if (admitted.length === 0) throw new MarketplaceError("all_orders_failed");

  const numbering = options.numbering;
  const parts: Uint8Array[] = [];
  for (let position = 0; position < admitted.length; position += 1) {
    let part = admitted[position];
    if (numbering) {
      const value = numbering.start + position;
      const prefix = numbering.letter ?? "";
      part = await stampTopLeftNumber(part, numbering.showTotal ? `${prefix}${value}/${admitted.length}` : `${prefix}${value}`);
    }
    parts.push(part);
  }

  return {
    marketplace: "shopee",
    bytes: await concatPdfs(parts),
    orderCount: slices.length,
    succeeded: admitted.length,
    failed: slices.length - admitted.length,
    outcomes,
  };
}
