import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { PdfAnalyzer } from "@/engine/analyzer";
import { TemplateDetector } from "@/engine/detector";
import { TemplateExtractor } from "@/engine/extractor";
import { convertPdf } from "@/engine/index";
import { SafeLayoutEngine } from "@/engine/layout";
import { SYNTHETIC_CODES, syntheticPdf } from "./fixtures/synthetic-pdf";

async function extract(bytes: Uint8Array) {
  const analysis = await new PdfAnalyzer().analyze(bytes);
  const detection = await new TemplateDetector().detect(analysis);
  return new TemplateExtractor().extract(analysis, detection);
}

describe("compact fiscal strip", () => {
  it("fits the logistics label and a summarized DANFE into one 100 x 150 mm page", async () => {
    const result = await convertPdf(await syntheticPdf({ fiscalSummary: true }), { preset: "100x150" });
    expect(result.pageCount).toBe(1);
    expect(result.validation).toEqual({ contentPreserved: true, geometryValid: true, codesEquivalent: true });
    const page = (await PDFDocument.load(result.bytes)).getPage(0);
    expect(page.getWidth()).toBeCloseTo(283.4646, 1);
    expect(page.getHeight()).toBeCloseTo(425.1969, 1);
  });

  it("reads the fiscal fields exactly and keeps the logistics label at original scale", async () => {
    const extraction = await extract(await syntheticPdf({ fiscalSummary: true, reverse: true }));
    expect(extraction.fiscalSummary).toEqual({
      operation: "Saída", number: "123", series: "1", issuedOn: "06/10/2026", accessKey: SYNTHETIC_CODES.danfeAccessKey,
    });
    const plan = await new SafeLayoutEngine().layout(extraction, { preset: "100x150" });
    expect(plan.scale).toBe(1);
    expect(plan.regions.every((region) => region.role === "logistics")).toBe(true);
    expect(plan.fiscalStrip?.summary.accessKey).toBe(SYNTHETIC_CODES.danfeAccessKey);
    expect(plan.fiscalStrip!.digitsBaseline).toBeGreaterThan(0);
  });

  it("keeps the full fiscal page when the summary cannot be trusted", async () => {
    // No printed header fields: nothing to summarize, so every region is preserved and 100 x 150 is too small.
    const plain = await extract(await syntheticPdf());
    expect(plain.fiscalSummary).toBeUndefined();
    await expect(convertPdf(await syntheticPdf(), { preset: "100x150" })).rejects.toMatchObject({ code: "format_too_small" });
    // Scans are never summarized from recognized text.
    await expect(new SafeLayoutEngine().layout({ ...plain, fiscalSummary: undefined }, { preset: "custom", widthMm: 100, heightMm: 250 }))
      .resolves.toMatchObject({ scale: 1 });
  });

  it("prints caller-supplied picking data above the label and still validates every code", async () => {
    const product = { quantity: 2, title: "Produto sintetico de teste com nome longo para quebrar em duas linhas", sku: "SKU-SINTETICO-01", variation: "Cor: Verde" };
    const extraction = await extract(await syntheticPdf({ fiscalSummary: true }));
    const plan = await new SafeLayoutEngine().layout(extraction, { preset: "100x150" }, { product });
    expect(plan.productHeader?.product).toEqual(product);
    expect(plan.scale).toBeGreaterThanOrEqual(0.8);
    expect(plan.productHeader!.box.bottom).toBeGreaterThan(plan.regions[0]!.outputBox.top);
    const result = await convertPdf(await syntheticPdf({ fiscalSummary: true }), { preset: "100x150" }, undefined, undefined, { product });
    expect(result.validation.codesEquivalent).toBe(true);
    await expect(new SafeLayoutEngine().layout(extraction, { preset: "100x150" }, { product: { quantity: 0, title: "x" } }))
      .rejects.toMatchObject({ code: "validation_failed" });
  });

  it("rejects a format where the label would have to shrink below the legibility floor", async () => {
    await expect(convertPdf(await syntheticPdf({ fiscalSummary: true }), { preset: "100x100" }))
      .rejects.toMatchObject({ code: "format_too_small" });
  });
});
