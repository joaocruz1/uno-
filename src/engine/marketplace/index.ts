import { convertMercadoLivreBatch } from "./mercado-livre";
import { convertShopeeBatch } from "./shopee";
import type { Marketplace, MarketplaceBatchOptions, MarketplaceBatchResult } from "./types";

export * from "./errors";
export * from "./types";
export * from "./order";
export { concatPdfs, splitIntoOrderPdfs, stampTopLeftNumber } from "./pdf";
export { buildPickingListPdf, type PickingListOptions, type PickingListPaper } from "./picking-list";
export { type OrderExtractor, extractMercadoLivreOrders, orderExtractorFor } from "./extraction";
export {
  createZplRenderer,
  DEFAULT_ZPL_LIMITS,
  preprocessZpl,
  ZplError,
  type ZplBlock,
  type ZplDocument,
  type ZplErrorCode,
  type ZplLimits,
  type ZplRenderer,
  type ZplRenderTarget,
} from "./zpl";
export {
  assertSpreadsheetSafe,
  createShopeeWorkbookReader,
  normalizeHeader,
  parseShopeePacking,
  SHOPEE_MAX_BYTES,
  ShopeeError,
  type ShopeeErrorCode,
  type ShopeeWorkbookReader,
} from "./shopee-excel";
export {
  combineInterleaved,
  convertTikTokBatch,
  createTikTokExtractor,
  normalizeTrackingKey,
  planInterleave,
  TikTokError,
  type InterleaveEntry,
  type InterleavePlan,
  type InvoiceUnit,
  type LabelUnit,
  type TikTokErrorCode,
  type TikTokExtractor,
} from "./tiktok";
export { convertMercadoLivreBatch } from "./mercado-livre";
export { convertShopeeBatch, readShopeeBarcode, type ShopeeBatchOptions, type ShopeeOrderValidator } from "./shopee";

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
    case "shopee":
      return convertShopeeBatch(input, options);
    default:
      throw new Error(`Marketplace não suportado: ${marketplace satisfies never}`);
  }
}
