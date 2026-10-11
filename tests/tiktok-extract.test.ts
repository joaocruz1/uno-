import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { convertTikTokBatch, createTikTokDocumentExtractor, planInterleave, TikTokError } from "@/engine/marketplace";

/** Shipping-label PDF: per order a 10×15 "Shipping label" page then its "Packing slip". */
async function labelsPdf(orderIds: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const id of orderIds) {
    const label = doc.addPage([283, 425]);
    label.drawText("TikTok Shop", { x: 20, y: 400, size: 14, font });
    label.drawText("Shipping label", { x: 20, y: 382, size: 10, font });
    label.drawText(`Order ID: ${id}`, { x: 20, y: 362, size: 10, font });
    const packing = doc.addPage([283, 425]);
    packing.drawText("Packing slip", { x: 20, y: 400, size: 12, font });
    packing.drawText(`Order ID: ${id}`, { x: 20, y: 380, size: 10, font });
  }
  return new Uint8Array(await doc.save());
}

/** NF-e PDF: one A4 DANFE per order, carrying its "Pedido TikTok" number. */
async function nfePdf(orderIds: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const id of orderIds) {
    const page = doc.addPage([595, 842]);
    page.drawText("DANFE - DOCUMENTO DE TESTE", { x: 40, y: 800, size: 12, font });
    page.drawText(`Pedido TikTok: ${id}`, { x: 40, y: 760, size: 10, font });
  }
  return new Uint8Array(await doc.save());
}

const A = "576420192164782032";
const B = "576471027559449434";

describe("createTikTokDocumentExtractor", () => {
  it("groups each label with its packing slip, keyed by Order ID", async () => {
    const extractor = createTikTokDocumentExtractor();
    const labels = await extractor.extractLabels(await labelsPdf([A, B]));
    expect(labels.map((label) => label.key)).toEqual([A, B]);
    expect((await PDFDocument.load(labels[0].pdf)).getPageCount()).toBe(2);
  });

  it("reads one invoice per NF-e page, keyed by the TikTok order number", async () => {
    const extractor = createTikTokDocumentExtractor();
    const invoices = await extractor.extractInvoices(await nfePdf([A, B]));
    expect(invoices.map((invoice) => invoice.key)).toEqual([A, B]);
    expect((await PDFDocument.load(invoices[0].pdf)).getPageCount()).toBe(1);
  });

  it("interleaves each label with its matching NF-e, even out of order", async () => {
    const extractor = createTikTokDocumentExtractor();
    const labels = await extractor.extractLabels(await labelsPdf([A, B]));
    const invoices = await extractor.extractInvoices(await nfePdf([B, A]));
    const plan = planInterleave(labels, invoices);
    expect(plan.ordered.map((entry) => `${entry.kind}:${entry.key}`)).toEqual([`label:${A}`, `invoice:${A}`, `label:${B}`, `invoice:${B}`]);
    expect(plan.unmatchedLabels).toEqual([]);
    expect(plan.unmatchedInvoices).toEqual([]);
  });

  it("runs convertTikTokBatch end to end: label(2pp)+invoice(1pp) per order", async () => {
    const { bytes, plan } = await convertTikTokBatch(await labelsPdf([A, B]), await nfePdf([A, B]), createTikTokDocumentExtractor());
    expect(plan.unmatchedLabels).toEqual([]);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(6);
  });

  it("refuses a PDF without the expected 'Shipping label' marker", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([283, 425]).drawText("algo qualquer", { x: 20, y: 400, size: 10, font: await doc.embedFont(StandardFonts.Helvetica) });
    await expect(createTikTokDocumentExtractor().extractLabels(new Uint8Array(await doc.save()))).rejects.toBeInstanceOf(TikTokError);
  });
});
