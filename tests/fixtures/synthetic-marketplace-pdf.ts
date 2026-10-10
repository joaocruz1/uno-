import { PDFDocument } from "pdf-lib";

import { syntheticPdf, type SyntheticPdfOptions } from "./synthetic-pdf";

/**
 * Builds a Mercado Livre `*_labels.pdf`-shaped fixture: N orders concatenated,
 * each the two-page (logistics + DANFE) synthetic label. Per-order options can
 * vary to exercise mixed success/failure (e.g. one `{ unknown: true }` order).
 */
export async function syntheticMercadoLivreBatch(
  orders: number | readonly SyntheticPdfOptions[],
): Promise<Uint8Array> {
  const list: SyntheticPdfOptions[] = typeof orders === "number"
    ? Array.from({ length: orders }, () => ({ fiscalSummary: true }))
    : [...orders];
  const out = await PDFDocument.create();
  for (const options of list) {
    const order = await PDFDocument.load(await syntheticPdf(options), { updateMetadata: false });
    const copied = await out.copyPages(order, order.getPageIndices());
    for (const page of copied) out.addPage(page);
  }
  return out.save({ useObjectStreams: true });
}
