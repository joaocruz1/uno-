import { MarketplaceError } from "./errors";
import type { Order } from "./order";
import type { Marketplace } from "./types";

/**
 * Reads the structured orders ({@link Order}) from a marketplace export — the
 * same bytes the batch pipeline (./mercado-livre) splits into labels. It is the
 * only layout-dependent piece of the lote pipeline: everything downstream (the
 * grouping/sum/sector transforms in ./order and the PDF in ./picking-list)
 * operates on the {@link Order} data this returns, so it is shared across
 * marketplaces.
 *
 * Runs inside the isolated engine process: the values it reads (SKU, quantity,
 * title, buyer) are drawn onto the user's own picking list and never persisted
 * to columns, logs or telemetry (specs/.../pdf-engine-v1.md).
 */
export interface OrderExtractor {
  extract(input: Uint8Array | readonly Uint8Array[]): Promise<Order[]>;
}

/**
 * Mercado Livre order extractor — NOT YET AVAILABLE.
 *
 * The picking-list engine that consumes {@link Order} data is complete and
 * tested; what remains is binding the ML text layout to those fields, and that
 * cannot be guessed. Per CLAUDE.md the engine recusa documento ambíguo em vez de
 * arriscar ("não existe melhor esforço"), so this refuses with a typed error
 * until the field mapping is pinned against a real `*_labels.pdf` sample.
 *
 * Planned implementation, once the sample lands in `.tmp/amostras/` (git-ignored):
 *  1. Split the file into 2-page order slices with {@link splitIntoOrderPdfs}
 *     (already used by the converter), so each slice is one order.
 *  2. Analyze each slice with the engine analyzer to get positioned text items
 *     (same pdfjs path as `src/engine/analyzer.ts`).
 *  3. Map the canhoto / folha de resumo spans to {@link OrderItem} fields
 *     (SKU, variação, quantidade, título) and the label's sequence to
 *     {@link Order.label} — the layout-specific step the sample pins down.
 *     Mercado Livre details the canhoto per unit only with ≤2 distinct products
 *     and emits a resumo sheet with >2 (plan, Apêndice E), which this step keys on.
 *  4. Return one {@link Order} per slice, in file order.
 */
export const extractMercadoLivreOrders: OrderExtractor["extract"] = async () => {
  throw new MarketplaceError(
    "extraction_unavailable",
    "A leitura de itens do Mercado Livre depende de uma amostra real do *_labels.pdf para fixar o layout; a lista de separação já está pronta para consumir os dados assim que a extração for liberada.",
  );
};

export function orderExtractorFor(marketplace: Marketplace): OrderExtractor {
  switch (marketplace) {
    case "mercado-livre":
      return { extract: extractMercadoLivreOrders };
    default:
      throw new Error(`Marketplace sem extrator: ${marketplace satisfies never}`);
  }
}
