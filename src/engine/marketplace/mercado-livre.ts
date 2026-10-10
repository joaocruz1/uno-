import { EngineError } from "../errors";
import { convertPdf } from "../index";
import { TEMPLATE_KEY } from "../types";
import { MarketplaceError } from "./errors";
import { concatPdfs, splitIntoOrderPdfs, stampTopLeftNumber } from "./pdf";
import type { MarketplaceBatchOptions, MarketplaceBatchResult, OrderOutcome } from "./types";

/** Logistics label + DANFE: two pages per order in the `*_labels.pdf`. */
const ML_PAGES_PER_ORDER = 2;
const DEFAULT_MAX_ORDERS = 500;

function labelText(letter: string, value: number, total: number | undefined): string {
  return total === undefined ? `${letter}${value}` : `${letter}${value}/${total}`;
}

/**
 * Converts a Mercado Livre `*_labels.pdf` that holds N orders into a single PDF
 * with one 10×15 label per order. Each order runs through the existing
 * single-order engine, so it inherits the full barcode-equivalence validation;
 * an order that fails is recorded and skipped, never failing the whole lote.
 *
 * Accepts several files (the vendor may drop more than one export): they are
 * concatenated in the given order, then split into orders — so the output PDF
 * follows the upload order, which the caller controls.
 */
export async function convertMercadoLivreBatch(
  input: Uint8Array | readonly Uint8Array[],
  options: MarketplaceBatchOptions = {},
): Promise<MarketplaceBatchResult> {
  const outputSize = options.outputSize ?? { preset: "100x150" };
  const maxOrders = options.maxOrders ?? DEFAULT_MAX_ORDERS;

  const files = Array.isArray(input) ? input : [input as Uint8Array];
  if (files.length === 0) throw new MarketplaceError("empty_document");
  const combined = files.length === 1 ? files[0] : await concatPdfs(files);
  const slices = await splitIntoOrderPdfs(combined, ML_PAGES_PER_ORDER);
  if (slices.length > maxOrders) {
    throw new MarketplaceError(
      "too_many_orders",
      `O arquivo tem ${slices.length} pedidos; o limite por lote é ${maxOrders}.`,
    );
  }

  const converted: Uint8Array[] = [];
  const outcomes: OrderOutcome[] = [];
  for (let index = 0; index < slices.length; index += 1) {
    try {
      const result = await convertPdf(slices[index], outputSize, TEMPLATE_KEY);
      converted.push(result.bytes);
      outcomes.push({ index, ok: true });
    } catch (error) {
      const errorCode = error instanceof EngineError ? error.code : "validation_failed";
      const errorMessage = error instanceof Error ? error.message : "Falha ao converter o pedido.";
      outcomes.push({ index, ok: false, errorCode, errorMessage });
    }
  }
  if (converted.length === 0) throw new MarketplaceError("all_orders_failed");

  const numbering = options.numbering;
  const parts: Uint8Array[] = [];
  for (let position = 0; position < converted.length; position += 1) {
    let part = converted[position];
    if (numbering) {
      const value = numbering.start + position;
      const text = labelText(numbering.letter ?? "", value, numbering.showTotal ? converted.length : undefined);
      part = await stampTopLeftNumber(part, text);
    }
    parts.push(part);
  }

  return {
    marketplace: "mercado-livre",
    bytes: await concatPdfs(parts),
    orderCount: slices.length,
    succeeded: converted.length,
    failed: slices.length - converted.length,
    outcomes,
  };
}
