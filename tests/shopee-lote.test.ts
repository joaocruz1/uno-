import bwipjs from "bwip-js/node";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { convertShopeeBatch, MarketplaceError } from "@/engine/marketplace";

const WIDTH = 283.465;
const HEIGHT = 425.197;

async function drawLabel(doc: PDFDocument, tracking: string | null, size: { w: number; h: number } = { w: WIDTH, h: HEIGHT }): Promise<void> {
  const page = doc.addPage([size.w, size.h]);
  if (tracking !== null) {
    const png = await bwipjs.toBuffer({ bcid: "code128", text: tracking, scale: 3, height: 14, includetext: false });
    const image = await doc.embedPng(png);
    const barWidth = size.w * 0.8;
    const barHeight = 64;
    page.drawImage(image, { x: (size.w - barWidth) / 2, y: size.h - 150, width: barWidth, height: barHeight });
  }
}

/** Builds a Shopee-like label PDF: one page per entry. A null tracking draws a
 * blank page (no barcode); a size overrides the 10×15 page box (for the guard). */
async function shopeeLabelsPdf(entries: { tracking: string | null; size?: { w: number; h: number } }[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const entry of entries) await drawLabel(doc, entry.tracking, entry.size);
  return new Uint8Array(await doc.save());
}

const okEntry = (n: number) => ({ tracking: `BR${String(n).padStart(12, "0")}` });

describe("convertShopeeBatch", () => {
  it("admits each 10×15 label whose barcode decodes, one page per order", async () => {
    const pdf = await shopeeLabelsPdf([okEntry(1), okEntry(2), okEntry(3)]);
    const result = await convertShopeeBatch(pdf);
    expect(result.marketplace).toBe("shopee");
    expect(result.orderCount).toBe(3);
    expect(result.succeeded).toBe(3);
    expect(result.failed).toBe(0);
    expect((await PDFDocument.load(result.bytes)).getPageCount()).toBe(3);
  });

  it("rejects a page that is not 10×15 without failing the lote", async () => {
    const pdf = await shopeeLabelsPdf([okEntry(1), { tracking: "BR999", size: { w: 595.276, h: 841.89 } }, okEntry(2)]);
    const result = await convertShopeeBatch(pdf);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    const failure = result.outcomes.find((outcome) => !outcome.ok);
    expect(failure).toMatchObject({ index: 1, ok: false, errorCode: "unexpected_label_size" });
    expect((await PDFDocument.load(result.bytes)).getPageCount()).toBe(2);
  });

  it("rejects a 10×15 label whose barcode cannot be read", async () => {
    const pdf = await shopeeLabelsPdf([okEntry(1), { tracking: null }]);
    const result = await convertShopeeBatch(pdf);
    expect(result.succeeded).toBe(1);
    expect(result.outcomes.find((outcome) => !outcome.ok)).toMatchObject({ index: 1, errorCode: "barcode_unreadable" });
  });

  it("throws when no order can be admitted", async () => {
    const pdf = await shopeeLabelsPdf([{ tracking: null }, { tracking: null }]);
    await expect(convertShopeeBatch(pdf)).rejects.toBeInstanceOf(MarketplaceError);
  });

  it("stamps numbering per position and keeps the page count", async () => {
    const pdf = await shopeeLabelsPdf([okEntry(1), okEntry(2)]);
    const result = await convertShopeeBatch(pdf, { numbering: { letter: "C", start: 7, showTotal: true } });
    expect(result.succeeded).toBe(2);
    expect((await PDFDocument.load(result.bytes)).getPageCount()).toBe(2);
  });

  it("concatenates several files in upload order (stub validator skips rendering)", async () => {
    const first = await shopeeLabelsPdf([okEntry(1), okEntry(2)]);
    const second = await shopeeLabelsPdf([okEntry(3)]);
    const result = await convertShopeeBatch([first, second], { validateOrder: async () => "ok" });
    expect(result.orderCount).toBe(3);
    expect(result.succeeded).toBe(3);
  });
});
