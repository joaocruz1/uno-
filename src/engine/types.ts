export const ENGINE_VERSION = "0.1.0";
/** Identity of the first registered layout; other layouts live in ./templates. */
export const TEMPLATE_KEY = "mercado-livre";
export const TEMPLATE_VERSION = "1.0.0";

export type OutputSize =
  | { preset: "100x150" | "100x100" | "a6" }
  | { preset: "custom"; widthMm: number; heightMm: number };

export type PageRole = "logistics" | "danfe";
export type PageKind = "digital" | "scanned";
export type ProtectedCodeFormat = "CODE_128" | "QR_CODE";

export type PdfRect = { left: number; bottom: number; right: number; top: number };
export type TextEvidence = { text: string; box: PdfRect };

export type AnalyzedPage = {
  pageNumber: number;
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  kind: PageKind;
  text: string;
  textItems: TextEvidence[];
  imageBoxes: PdfRect[];
  pathBoxes: PdfRect[];
};

export type Analysis = { bytes: Uint8Array; pages: [AnalyzedPage, AnalyzedPage] };

export type OcrBlock = { text: string; confidence: number; box: PdfRect };
export type DetectedPage = AnalyzedPage & { role: PageRole; evidence: string; ocrBlocks: OcrBlock[] };
export type Detection = {
  templateKey: string;
  templateVersion: string;
  pages: [DetectedPage, DetectedPage];
};

export type ExtractedRegion = {
  id: string;
  pageNumber: number;
  role: PageRole;
  box: PdfRect;
  populated: boolean;
};

export type ProtectedCodeRegion = {
  id: string;
  pageNumber: number;
  format: ProtectedCodeFormat;
  box: PdfRect;
};

/** Optional picking data supplied by the caller; it is never read from the document. */
export type ProductHeader = {
  quantity: number;
  title: string;
  sku?: string;
  variation?: string;
};

export type ConversionOptions = { product?: ProductHeader };

/** Fields of a digital DANFE that a compact label repeats beside the access-key barcode. */
export type FiscalSummary = {
  operation: string;
  number: string;
  series: string;
  issuedOn: string;
  accessKey: string;
};

export type Extraction = {
  analysis: Analysis;
  detection: Detection;
  /** Present only when the fiscal page is digital and every field was read exactly. */
  fiscalSummary?: FiscalSummary;
  regions: ExtractedRegion[];
  protectedCodes: ProtectedCodeRegion[];
  contentBoxes: Array<{ pageNumber: number; kind: "text" | "image" | "ink"; box: PdfRect }>;
};

export type PlacedRegion = ExtractedRegion & { outputBox: PdfRect };
export type PlacedProtectedCode = ProtectedCodeRegion & { outputBox: PdfRect };

/** Compact replacement for the fiscal page: title bar, one data line and the original key barcode. */
export type FiscalStrip = {
  summary: FiscalSummary;
  codeId: string;
  pageNumber: number;
  titleBar: PdfRect;
  lineBaseline: number;
  barcodeSourceBox: PdfRect;
  barcodeOutputBox: PdfRect;
  digitsBaseline: number;
};

export type LayoutPlan = {
  extraction: Extraction;
  widthMm: number;
  heightMm: number;
  widthPt: number;
  heightPt: number;
  /** 1 unless the logistics label had to shrink slightly to share the page with the fiscal strip. */
  scale: number;
  regions: PlacedRegion[];
  protectedCodes: PlacedProtectedCode[];
  fiscalStrip?: FiscalStrip;
  productHeader?: { box: PdfRect; product: ProductHeader };
};

export type ComposedPdf = { bytes: Uint8Array; layout: LayoutPlan };

export type ValidationResult = {
  contentPreserved: true;
  geometryValid: true;
  codesEquivalent: true;
};

export type EngineStage = "analyze" | "detect" | "extract" | "layout" | "compose" | "validate";
export type ProgressEvent = { stage: EngineStage; progress: number };
export type ProgressHandler = (event: ProgressEvent) => void | Promise<void>;

export type ConversionResult = {
  bytes: Uint8Array;
  pageCount: 1;
  widthMm: number;
  heightMm: number;
  versions: {
    engine: typeof ENGINE_VERSION;
    templateKey: string;
    template: string;
  };
  validation: ValidationResult;
  timingsMs: Record<EngineStage, number>;
  pages: Array<{
    pageNumber: number;
    role: PageRole;
    kind: PageKind;
    rotation: 0 | 90 | 180 | 270;
    regionCount: number;
  }>;
};

export interface Analyzer {
  analyze(bytes: Uint8Array): Promise<Analysis>;
}

export interface Detector {
  detect(analysis: Analysis, selectedTemplate?: string): Promise<Detection>;
}

export interface Extractor {
  extract(analysis: Analysis, detection: Detection): Promise<Extraction>;
}

export interface Layout {
  layout(extraction: Extraction, outputSize: OutputSize, options?: ConversionOptions): Promise<LayoutPlan>;
}

export interface Composer {
  compose(plan: LayoutPlan): Promise<ComposedPdf>;
}

export interface Validator {
  validate(composed: ComposedPdf): Promise<ValidationResult>;
}
