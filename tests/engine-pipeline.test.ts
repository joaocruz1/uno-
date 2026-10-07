import {
  PDFDocument,
  PDFName,
  concatTransformationMatrix,
  drawObject,
  fill,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  setFillingRgbColor,
} from "pdf-lib";
import { describe, expect, it } from "vitest";

import {
  EngineError,
  MercadoLivreDetector,
  MercadoLivreExtractor,
  PdfAnalyzer,
  RenderedPdfValidator,
  SafeLayoutEngine,
  VectorPdfComposer,
  convertPdf,
  detectTemplate,
  extractContent,
  type ProgressEvent,
} from "@/engine";
import { syntheticPdf, syntheticPdfWithJavaScript } from "./fixtures/synthetic-pdf";

const SAFE_OUTPUT = { preset: "custom", widthMm: 100, heightMm: 210 } as const;

function hasCode(code: string) {
  return (error: unknown) => error instanceof EngineError && error.code === code;
}

describe("UNO PDF engine pipeline", () => {
  it("converts a synthetic digital pair with additional fiscal content and validates all protected codes", async () => {
    const input = await syntheticPdf({ additionalInformation: true });
    const progress: ProgressEvent[] = [];
    const started = performance.now();
    const result = await convertPdf(input, SAFE_OUTPUT, "mercado-livre@1.0.0", (event) => { progress.push(event); });

    expect(result.pageCount).toBe(1);
    expect(result.widthMm).toBe(100);
    expect(result.heightMm).toBe(210);
    expect(result.versions).toEqual({ engine: "0.1.0", templateKey: "mercado-livre", template: "1.0.0" });
    expect(result.validation).toEqual({ contentPreserved: true, geometryValid: true, codesEquivalent: true });
    expect(result.pages.map(({ role }) => role)).toEqual(["logistics", "danfe"]);
    expect(result.pages[1]?.regionCount).toBeGreaterThan(5);
    expect(progress).toEqual([
      { stage: "analyze", progress: 10 },
      { stage: "detect", progress: 25 },
      { stage: "extract", progress: 40 },
      { stage: "layout", progress: 60 },
      { stage: "compose", progress: 80 },
      { stage: "validate", progress: 100 },
    ]);
    const elapsedMs = performance.now() - started;
    expect(Object.values(result.timingsMs).every((duration) => Number.isFinite(duration) && duration >= 0)).toBe(true);
    expect(elapsedMs).toBeLessThan(3_000);

    const output = await PDFDocument.load(result.bytes);
    expect(output.getPageCount()).toBe(1);
    expect(output.getPage(0).getWidth()).toBeCloseTo(283.4646, 1);
    expect(output.getPage(0).getHeight()).toBeCloseTo(595.2756, 1);
  }, 30_000);

  it("fails validation when a non-code fiscal region is removed from otherwise valid output", async () => {
    const input = await syntheticPdf();
    const analysis = await new PdfAnalyzer().analyze(input);
    const detection = await new MercadoLivreDetector().detect(analysis);
    const extraction = await new MercadoLivreExtractor().extract(analysis, detection);
    const layout = await new SafeLayoutEngine().layout(extraction, SAFE_OUTPUT);
    const composed = await new VectorPdfComposer().compose(layout);
    const tampered = await PDFDocument.load(composed.bytes);
    const fiscalRegion = layout.regions.find((region) => region.id === "danfe_4");
    expect(fiscalRegion).toBeDefined();
    tampered.getPage(0).drawRectangle({
      x: fiscalRegion!.outputBox.left,
      y: fiscalRegion!.outputBox.bottom,
      width: fiscalRegion!.outputBox.right - fiscalRegion!.outputBox.left,
      height: fiscalRegion!.outputBox.top - fiscalRegion!.outputBox.bottom,
      color: rgb(1, 1, 1),
    });
    await expect(
      new RenderedPdfValidator().validate({ bytes: await tampered.save(), layout }),
    ).rejects.toSatisfy(hasCode("validation_failed"));
  }, 30_000);

  it("applies the graphics CTM before assigning painted vector paths to preserved regions", async () => {
    const source = await PDFDocument.load(await syntheticPdf());
    source.getPage(1).pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(1, 0, 0, 1, 0, -70),
      setFillingRgbColor(0, 0, 0),
      rectangle(20, 240, 20, 10),
      fill(),
      popGraphicsState(),
    );
    const bytes = await source.save();
    const analysis = await new PdfAnalyzer().analyze(bytes);
    expect(analysis.pages[1].pathBoxes).toContainEqual({ left: 20, bottom: 170, right: 40, top: 180 });
    const detection = await new MercadoLivreDetector().detect(analysis);
    const extraction = await new MercadoLivreExtractor().extract(analysis, detection);
    expect(extraction.regions.some((region) => region.pageNumber === 2 &&
      region.box.left <= 20 && region.box.right >= 40 && region.box.bottom <= 170 && region.box.top >= 180)).toBe(true);
    const result = await convertPdf(bytes, SAFE_OUTPUT);
    expect(result.validation.contentPreserved).toBe(true);
  }, 30_000);

  it("applies nested Form XObject matrices before assigning painted paths", async () => {
    const source = await PDFDocument.load(await syntheticPdf());
    const donor = await PDFDocument.create();
    const donorPage = donor.addPage([100, 100]);
    donorPage.drawRectangle({ x: 20, y: 30, width: 20, height: 10, color: rgb(0, 0, 0) });
    const embedded = await source.embedPage(donorPage, { left: 20, bottom: 30, right: 40, top: 40 });
    source.getPage(1).drawPage(embedded, { x: 20, y: 170, width: 20, height: 10 });
    const bytes = await source.save();

    const analysis = await new PdfAnalyzer().analyze(bytes);
    expect(analysis.pages[1].pathBoxes.some((box) =>
      Math.abs(box.left - 20) < 0.01 && Math.abs(box.bottom - 170) < 0.01 &&
      Math.abs(box.right - 40) < 0.01 && Math.abs(box.top - 180) < 0.01)).toBe(true);
    const detection = await new MercadoLivreDetector().detect(analysis);
    const extraction = await new MercadoLivreExtractor().extract(analysis, detection);
    expect(extraction.regions.some((region) => region.pageNumber === 2 &&
      region.box.left <= 20 && region.box.right >= 40 && region.box.bottom <= 170 && region.box.top >= 180)).toBe(true);
    const result = await convertPdf(bytes, SAFE_OUTPUT);
    expect(result.validation.contentPreserved).toBe(true);
  }, 30_000);

  it("keeps the enclosing Form matrix across a nested identity Form", async () => {
    const source = await PDFDocument.load(await syntheticPdf());
    const inner = source.context.formXObject([], { BBox: [0, 0, 1, 1], Resources: {} });
    inner.dict.delete(PDFName.of("Matrix"));
    const innerRef = source.context.register(inner);
    const outer = source.context.formXObject([
      drawObject("Inner"),
      setFillingRgbColor(0, 0, 0),
      rectangle(0, 0, 20, 10),
      fill(),
    ], {
      BBox: [0, 0, 20, 10],
      Matrix: [1, 0, 0, 1, 20, 170],
      Resources: { XObject: { Inner: innerRef } },
    });
    const outerRef = source.context.register(outer);
    const outerName = source.getPage(1).node.newXObject("Outer", outerRef);
    source.getPage(1).pushOperators(drawObject(outerName));

    const analysis = await new PdfAnalyzer().analyze(await source.save());
    expect(analysis.pages[1].pathBoxes).toContainEqual({ left: 20, bottom: 170, right: 40, top: 180 });
  });

  it("does not classify an arbitrary filled outer rectangle as the known thin structural frame", async () => {
    const source = await PDFDocument.load(await syntheticPdf());
    source.getPage(1).drawRectangle({
      x: 8.5039,
      y: 2.8346,
      width: 264.1889 - 8.5039,
      height: 424.3464 - 2.8346,
      color: rgb(0, 0, 0),
    });
    const analysis = await new PdfAnalyzer().analyze(await source.save());
    expect(analysis.pages[1].pathBoxes.some((box) =>
      Math.abs(box.left - 8.5039) < 0.01 && Math.abs(box.bottom - 2.8346) < 0.01 &&
      Math.abs(box.right - 264.1889) < 0.01 && Math.abs(box.top - 424.3464) < 0.01)).toBe(true);
  });

  it("detects reversed pages and normalizes supported page rotations", async () => {
    const input = await syntheticPdf({ reverse: true, rotations: [90, 270] });
    const result = await convertPdf(input, SAFE_OUTPUT);
    expect(result.pages).toMatchObject([
      { pageNumber: 1, role: "danfe", rotation: 90 },
      { pageNumber: 2, role: "logistics", rotation: 270 },
    ]);
    expect(result.validation.codesEquivalent).toBe(true);
  }, 30_000);

  it("rejects a format that cannot preserve native text and code scale", async () => {
    await expect(convertPdf(await syntheticPdf(), { preset: "100x150" })).rejects.toMatchObject({
      code: "format_too_small",
      terminal: true,
      suggestedSize: undefined,
    });
  });

  it("rejects unknown, ambiguous, and mismatched pinned templates", async () => {
    await expect(convertPdf(await syntheticPdf({ unknown: true }), SAFE_OUTPUT)).rejects.toSatisfy(hasCode("unsupported_template"));
    await expect(convertPdf(await syntheticPdf({ ambiguous: true }), SAFE_OUTPUT)).rejects.toSatisfy(hasCode("ambiguous_template"));
    await expect(convertPdf(await syntheticPdf(), SAFE_OUTPUT, "other-marketplace@1.0.0")).rejects.toSatisfy(
      hasCode("unsupported_template"),
    );
  });

  it("rejects corrupt, active-content, and wrong-page-count PDFs with safe typed errors", async () => {
    await expect(new PdfAnalyzer().analyze(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).rejects.toSatisfy(hasCode("invalid_pdf"));
    await expect(new PdfAnalyzer().analyze(await syntheticPdfWithJavaScript())).rejects.toSatisfy(hasCode("invalid_pdf"));
    const onePage = await PDFDocument.create();
    onePage.addPage([283.4646, 425.1969]);
    await expect(new PdfAnalyzer().analyze(await onePage.save())).rejects.toSatisfy(hasCode("invalid_page_count"));
  });

  it.skipIf(!process.env.TESSDATA_PREFIX)("uses OCR only for detection while preserving scanned source pixels", async () => {
    const input = await syntheticPdf({ scanned: true, additionalInformation: true });
    const analysis = await new PdfAnalyzer().analyze(input);
    expect(analysis.pages.every((page) => page.kind === "scanned")).toBe(true);
    const detection = await detectTemplate(analysis);
    const extraction = await extractContent(analysis, detection);
    expect(extraction.detection.pages.every((page) => page.ocrBlocks.length > 0)).toBe(true);
    const result = await convertPdf(input, SAFE_OUTPUT);
    expect(result.pages.every((page) => page.kind === "scanned")).toBe(true);
    expect(result.validation.codesEquivalent).toBe(true);
  }, 90_000);
});
