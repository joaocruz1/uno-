import { PDFDocument, rgb, StandardFonts } from "pdf-lib";

import { MarketplaceError } from "./errors";

/**
 * Splits a marketplace PDF into one sub-PDF per order so each can run through
 * the existing single-order engine (`convertPdf`).
 *
 * v1 assumption: orders are fixed-size, contiguous page groups (Mercado Livre =
 * 2 pages: logistics + DANFE). The real `*_labels.pdf` may interleave a resumo
 * sheet or canhoto-less orders — that boundary detection is the piece to tune
 * against a real sample; it plugs in here without touching the rest.
 */
export async function splitIntoOrderPdfs(bytes: Uint8Array, pagesPerOrder: number): Promise<Uint8Array[]> {
  const source = await PDFDocument.load(bytes, { updateMetadata: false });
  const total = source.getPageCount();
  if (total === 0) throw new MarketplaceError("empty_document");
  if (total % pagesPerOrder !== 0) {
    throw new MarketplaceError(
      "page_count_mismatch",
      `O PDF tem ${total} páginas, que não é múltiplo de ${pagesPerOrder} (um pedido).`,
    );
  }
  const slices: Uint8Array[] = [];
  for (let start = 0; start < total; start += pagesPerOrder) {
    const out = await PDFDocument.create();
    const indices = Array.from({ length: pagesPerOrder }, (_, offset) => start + offset);
    const copied = await out.copyPages(source, indices);
    for (const page of copied) out.addPage(page);
    slices.push(await out.save({ useObjectStreams: true }));
  }
  return slices;
}

/** Concatenates composed single-order PDFs into one, preserving each page box. */
export async function concatPdfs(parts: readonly Uint8Array[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  out.setProducer("UNO PDF Engine");
  out.setCreator("UNO");
  for (const part of parts) {
    const doc = await PDFDocument.load(part, { updateMetadata: false });
    const copied = await out.copyPages(doc, doc.getPageIndices());
    for (const page of copied) out.addPage(page);
  }
  return out.save({ useObjectStreams: true });
}

/**
 * Stamps the lote number in the top-left corner of every page of a composed
 * label. Applied after the per-order validation has already passed, so it never
 * affects the codes-equivalent guarantee. Exact placement (a reserved top band
 * vs. this overprint) is tuned against a real sample in the full ML phase.
 */
export async function stampTopLeftNumber(bytes: Uint8Array, text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const size = 10;
  const padX = 3;
  const padY = 2;
  for (const page of doc.getPages()) {
    const { height } = page.getSize();
    const boxWidth = font.widthOfTextAtSize(text, size) + padX * 2;
    const boxHeight = size + padY * 2;
    const top = height - 2;
    page.drawRectangle({ x: 2, y: top - boxHeight, width: boxWidth, height: boxHeight, color: rgb(1, 1, 1) });
    page.drawText(text, { x: 2 + padX, y: top - boxHeight + padY + 1, size, font, color: rgb(0, 0, 0) });
  }
  return doc.save({ useObjectStreams: true });
}
