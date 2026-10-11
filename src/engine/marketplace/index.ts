import { convertMercadoLivreBatch } from "./mercado-livre";
import type { Marketplace, MarketplaceBatchOptions, MarketplaceBatchResult } from "./types";

export * from "./errors";
export * from "./types";
export * from "./order";
export { concatPdfs, splitIntoOrderPdfs, stampTopLeftNumber } from "./pdf";
export { buildPickingListPdf, type PickingListOptions, type PickingListPaper } from "./picking-list";
export { type OrderExtractor, extractMercadoLivreOrders, orderExtractorFor } from "./extraction";
export { convertMercadoLivreBatch } from "./mercado-livre";

/**
 * Converts a marketplace export (N orders in one file) into a single
 * print-ready PDF. New marketplaces add a branch and a module beside this one;
 * the split/convert/concat machinery in ./pdf stays shared.
 */
export async function convertMarketplaceBatch(
  marketplace: Marketplace,
  input: Uint8Array | readonly Uint8Array[],
  options: MarketplaceBatchOptions = {},
): Promise<MarketplaceBatchResult> {
  switch (marketplace) {
    case "mercado-livre":
      return convertMercadoLivreBatch(input, options);
    default:
      throw new Error(`Marketplace não suportado: ${marketplace satisfies never}`);
  }
}
