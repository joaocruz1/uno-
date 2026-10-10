/** Batch-level failures of the marketplace pipeline. Per-order failures are not
 * errors of the batch: they are recorded as outcomes (see ./types) so the rest
 * of the lote still converts, mirroring how `src/server/batches` admits items. */
export type MarketplaceErrorCode =
  | "empty_document"
  | "page_count_mismatch"
  | "too_many_orders"
  | "all_orders_failed";

const SAFE_MESSAGES: Record<MarketplaceErrorCode, string> = {
  empty_document: "O arquivo não contém páginas.",
  page_count_mismatch: "O número de páginas não corresponde a pedidos completos.",
  too_many_orders: "O arquivo tem mais pedidos do que o limite por lote.",
  all_orders_failed: "Nenhum pedido do arquivo pôde ser convertido.",
};

export class MarketplaceError extends Error {
  constructor(
    readonly code: MarketplaceErrorCode,
    message?: string,
  ) {
    super(message ?? SAFE_MESSAGES[code]);
    this.name = "MarketplaceError";
  }
}
