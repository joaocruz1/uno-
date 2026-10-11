import { PDFDocument } from "pdf-lib";

import { type InvoiceUnit, type LabelUnit, TikTokError, type TikTokExtractor } from "./tiktok";

/**
 * Real TikTok extractor: reads the order key off each page's text layer (pdfjs)
 * and slices the two PDFs into per-order units (pdf-lib), feeding the match and
 * interleave logic in ./tiktok. It is tuned to the TikTok document layout —
 * "Shipping label"/"Packing slip" pages carrying "Order ID", and NF-e pages
 * carrying "Pedido TikTok" — and refuses with a typed error when those markers
 * are absent, rather than guessing (CLAUDE.md: "recusa em vez de arriscar").
 * A real seller export may differ (A6/A5, other wording, ZPL) and is the sample
 * that would harden this reader.
 *
 * Runs server-side; the text it reads (order ids, addresses) is only used to
 * pair and slice the documents and is never persisted (specs/.../pdf-engine-v1.md).
 */

const ORDER_ID = /Order\s*ID[:\s#]*([0-9]{6,})/i;
const PEDIDO = /Pedido\s*TikTok[:\s#]*([0-9]{6,})/i;
const SHIPPING_LABEL = /shipping\s*label/i;

async function readPageTexts(bytes: Uint8Array): Promise<string[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
    enableXfa: false,
    stopAtErrors: true,
    isImageDecoderSupported: false,
    isOffscreenCanvasSupported: false,
    maxImageSize: 15_000_000,
  } as Parameters<typeof pdfjs.getDocument>[0] & { isEvalSupported: false });
  try {
    const document = await loadingTask.promise;
    const texts: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = (content.items as { str?: string }[]).map((item) => item.str ?? "").join(" ").replace(/\s+/g, " ").trim();
      texts.push(text);
    }
    return texts;
  } catch {
    throw new TikTokError("tiktok_extraction_unavailable", "Não foi possível ler o PDF do TikTok.");
  } finally {
    await loadingTask.destroy().catch(() => undefined);
  }
}

async function slicePages(source: PDFDocument, indices: readonly number[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  const copied = await out.copyPages(source, [...indices]);
  for (const page of copied) out.addPage(page);
  return out.save({ useObjectStreams: true });
}

export function createTikTokDocumentExtractor(): TikTokExtractor {
  return {
    /**
     * Groups the shipping-label PDF into orders: a new order begins at each
     * "Shipping label" page and runs until the next one (so the packing slip
     * travels with its label). The key is that page's Order ID.
     */
    async extractLabels(bytes: Uint8Array): Promise<LabelUnit[]> {
      const texts = await readPageTexts(bytes);
      const source = await PDFDocument.load(bytes, { updateMetadata: false });
      const groups: { key: string; pages: number[] }[] = [];
      for (let index = 0; index < texts.length; index += 1) {
        if (SHIPPING_LABEL.test(texts[index])) {
          const key = ORDER_ID.exec(texts[index])?.[1];
          if (!key) throw new TikTokError("tiktok_extraction_unavailable", "Não consegui ler o Order ID de uma etiqueta do TikTok.");
          groups.push({ key, pages: [index] });
        } else if (groups.length > 0) {
          groups[groups.length - 1].pages.push(index);
        }
      }
      if (groups.length === 0) {
        throw new TikTokError("tiktok_extraction_unavailable", "Não encontrei etiquetas do TikTok (páginas 'Shipping label') no arquivo.");
      }
      const labels: LabelUnit[] = [];
      for (const group of groups) labels.push({ key: group.key, pdf: await slicePages(source, group.pages) });
      return labels;
    },

    /** One NF-e per page, keyed by the TikTok order number it carries. */
    async extractInvoices(bytes: Uint8Array): Promise<InvoiceUnit[]> {
      const texts = await readPageTexts(bytes);
      const source = await PDFDocument.load(bytes, { updateMetadata: false });
      const invoices: InvoiceUnit[] = [];
      for (let index = 0; index < texts.length; index += 1) {
        const key = PEDIDO.exec(texts[index])?.[1] ?? ORDER_ID.exec(texts[index])?.[1];
        if (!key) throw new TikTokError("tiktok_extraction_unavailable", "Não consegui casar uma página da NF-e com um pedido do TikTok.");
        invoices.push({ key, pdf: await slicePages(source, [index]) });
      }
      return invoices;
    },
  };
}
