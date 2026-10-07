import { PdfAnalyzer } from "./analyzer";
import { VectorPdfComposer } from "./composer";
import { MercadoLivreDetector } from "./detector";
import { MercadoLivreExtractor } from "./extractor";
import { SafeLayoutEngine } from "./layout";
import {
  ENGINE_VERSION,
  TEMPLATE_KEY,
  TEMPLATE_VERSION,
  type ConversionResult,
  type EngineStage,
  type OutputSize,
  type ProgressHandler,
} from "./types";
import { RenderedPdfValidator } from "./validator";

export * from "./analyzer";
export * from "./barcodes";
export * from "./composer";
export * from "./detector";
export * from "./errors";
export * from "./extractor";
export * from "./layout";
export * from "./render";
export * from "./types";
export * from "./validator";

async function measured<T>(stage: EngineStage, timings: Record<EngineStage, number>, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await work();
  } finally {
    timings[stage] = Math.round((performance.now() - started) * 100) / 100;
  }
}

export async function convertPdf(
  bytes: Uint8Array,
  outputSize: OutputSize,
  selectedTemplate?: string,
  onProgress?: ProgressHandler,
): Promise<ConversionResult> {
  const timingsMs: Record<EngineStage, number> = {
    analyze: 0,
    detect: 0,
    extract: 0,
    layout: 0,
    compose: 0,
    validate: 0,
  };
  const analyzer = new PdfAnalyzer();
  const detector = new MercadoLivreDetector();
  const extractor = new MercadoLivreExtractor();
  const layoutEngine = new SafeLayoutEngine();
  const composer = new VectorPdfComposer();
  const validator = new RenderedPdfValidator();

  const analysis = await measured("analyze", timingsMs, () => analyzer.analyze(bytes));
  await onProgress?.({ stage: "analyze", progress: 10 });
  const detection = await measured("detect", timingsMs, () => detector.detect(analysis, selectedTemplate));
  await onProgress?.({ stage: "detect", progress: 25 });
  const extraction = await measured("extract", timingsMs, () => extractor.extract(analysis, detection));
  await onProgress?.({ stage: "extract", progress: 40 });
  const layout = await measured("layout", timingsMs, () => layoutEngine.layout(extraction, outputSize));
  await onProgress?.({ stage: "layout", progress: 60 });
  const composed = await measured("compose", timingsMs, () => composer.compose(layout));
  await onProgress?.({ stage: "compose", progress: 80 });
  const validation = await measured("validate", timingsMs, () => validator.validate(composed));
  await onProgress?.({ stage: "validate", progress: 100 });

  return {
    bytes: composed.bytes,
    pageCount: 1,
    widthMm: layout.widthMm,
    heightMm: layout.heightMm,
    versions: { engine: ENGINE_VERSION, templateKey: TEMPLATE_KEY, template: TEMPLATE_VERSION },
    validation,
    timingsMs,
    pages: detection.pages.map((page) => ({
      pageNumber: page.pageNumber,
      role: page.role,
      kind: page.kind,
      rotation: page.rotation,
      regionCount: extraction.regions.filter((region) => region.pageNumber === page.pageNumber).length,
    })),
  };
}
