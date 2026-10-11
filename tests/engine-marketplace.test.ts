import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { convertMarketplaceBatch, convertMercadoLivreBatch, splitIntoOrderPdfs } from "@/engine/marketplace";
import { syntheticMercadoLivreBatch } from "./fixtures/synthetic-marketplace-pdf";

describe("marketplace lote pipeline (Mercado Livre)", () => {
  it("converts a multi-order file into one PDF with a 10x15 page per order", async () => {
    const result = await convertMarketplaceBatch("mercado-livre", await syntheticMercadoLivreBatch(3));
    expect(result.orderCount).toBe(3);
    expect(result.succeeded).toBe(3);
    expect(result.failed).toBe(0);
    const pdf = await PDFDocument.load(result.bytes);
    expect(pdf.getPageCount()).toBe(3);
    for (const page of pdf.getPages()) {
      expect(page.getWidth()).toBeCloseTo(283.4646, 1);
      expect(page.getHeight()).toBeCloseTo(425.1969, 1);
    }
  });

  it("joins several uploaded files into one PDF, in upload order", async () => {
    const result = await convertMercadoLivreBatch([
      await syntheticMercadoLivreBatch(1),
      await syntheticMercadoLivreBatch(2),
    ]);
    expect(result.orderCount).toBe(3);
    expect(result.succeeded).toBe(3);
    expect((await PDFDocument.load(result.bytes)).getPageCount()).toBe(3);
  });

  it("numbers each label and keeps one page per order", async () => {
    const result = await convertMercadoLivreBatch(await syntheticMercadoLivreBatch(2), {
      numbering: { start: 1, showTotal: true, letter: "C" },
    });
    expect(result.succeeded).toBe(2);
    expect((await PDFDocument.load(result.bytes)).getPageCount()).toBe(2);
  });

  it("skips an order that fails and still returns the rest", async () => {
    const result = await convertMercadoLivreBatch(
      await syntheticMercadoLivreBatch([{ fiscalSummary: true }, { unknown: true }]),
    );
    expect(result.orderCount).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    const failure = result.outcomes.find((outcome) => !outcome.ok);
    expect(failure).toMatchObject({ ok: false, index: 1 });
    expect((await PDFDocument.load(result.bytes)).getPageCount()).toBe(1);
  });

  it("throws when no order can be converted", async () => {
    await expect(convertMercadoLivreBatch(await syntheticMercadoLivreBatch([{ unknown: true }])))
      .rejects.toMatchObject({ code: "all_orders_failed" });
  });

  it("rejects a page count that is not whole orders", async () => {
    // A single 2-page order, then drop one page → 3 pages, not a multiple of 2.
    const base = await PDFDocument.load(await syntheticMercadoLivreBatch(2));
    base.removePage(3);
    await expect(splitIntoOrderPdfs(await base.save(), 2)).rejects.toMatchObject({ code: "page_count_mismatch" });
  });
});
