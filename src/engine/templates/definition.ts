import type { Analysis, AnalyzedPage, FiscalSummary, PageRole, PdfRect, ProtectedCodeRegion } from "../types";

export type AnchorBlock = { text: string; box: Pick<PdfRect, "bottom" | "top"> };

/**
 * Everything the six stages need to know about one versioned marketplace or
 * carrier layout. A new layout is a new definition registered in ./index.ts;
 * the analyzer, detector, extractor, layout, composer and validator stay generic.
 */
export interface TemplateDefinition {
  readonly key: string;
  readonly version: string;
  readonly displayName: string;
  readonly page: { readonly widthPt: number; readonly heightPt: number; readonly tolerancePt: number };
  /** Useful vertical bands per page role, measured in points from the top edge. */
  readonly bands: Readonly<Record<PageRole, ReadonlyArray<readonly [number, number]>>>;
  /** Decorative frame around the page that carries no document content. */
  readonly structuralOuterFrame?: PdfRect;
  readonly minimumScores: Readonly<Record<PageRole, number>>;
  /** Receives text already passed through normalizeEvidenceText. */
  scoreRoles(normalizedText: string): Record<PageRole, number>;
  matchesRoleGeometry(page: AnalyzedPage, blocks: readonly AnchorBlock[], role: PageRole): boolean;
  protectedCodes(logisticsPage: number, danfePage: number): ProtectedCodeRegion[];
  /**
   * Compact output: the fiscal page is replaced by a strip with these fields
   * and the original access-key barcode. Implementations read digital text
   * only and return undefined on any doubt, which keeps the full fiscal page.
   */
  readonly compactFiscal?: {
    readonly barcodeId: string;
    summarize(page: AnalyzedPage): FiscalSummary | undefined;
  };
}

/**
 * Protected code boxes for one document. The template box is where the code
 * normally is; on a digital page the code is an image, and the marketplace may
 * slide it sideways (Mercado Livre puts a service icon on the left of the
 * logistics barcode for some shipments). The image that fills the same
 * vertical band with about the same size is the real code, so its exact box is
 * used. Anything less certain keeps the template box, and the validator still
 * decodes both sides, so a wrong match can only fail, never pass silently.
 */
export function resolveProtectedCodes(
  definition: TemplateDefinition,
  analysis: Analysis,
  logisticsPage: number,
  danfePage: number,
): ProtectedCodeRegion[] {
  return definition.protectedCodes(logisticsPage, danfePage).map((code) => {
    const page = analysis.pages.find((candidate) => candidate.pageNumber === code.pageNumber);
    if (!page || page.kind !== "digital") return code;
    const expectedWidth = code.box.right - code.box.left;
    const expectedHeight = code.box.top - code.box.bottom;
    const candidates = page.imageBoxes.filter((image) => {
      const verticalOverlap = Math.min(image.top, code.box.top) - Math.max(image.bottom, code.box.bottom);
      const horizontalOverlap = Math.min(image.right, code.box.right) - Math.max(image.left, code.box.left);
      return verticalOverlap >= expectedHeight * 0.8 && horizontalOverlap > 0 &&
        Math.abs(image.right - image.left - expectedWidth) <= PROTECTED_CODE_SIZE_TOLERANCE_PT &&
        Math.abs(image.top - image.bottom - expectedHeight) <= PROTECTED_CODE_SIZE_TOLERANCE_PT &&
        image.left >= -0.5 && image.right <= page.width + 0.5;
    });
    if (candidates.length !== 1) return code;
    const [image] = candidates;
    return { ...code, box: { left: image.left, bottom: image.bottom, right: image.right, top: image.top } };
  });
}

/** How far a code image may differ in size from the template box and still be the same code. */
export const PROTECTED_CODE_SIZE_TOLERANCE_PT = 25;

export function normalizeEvidenceText(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ");
}

/** True when a block containing the anchor is vertically centred inside the given top-down range. */
export function anchorAt(
  page: Pick<AnalyzedPage, "height">,
  blocks: readonly AnchorBlock[],
  anchor: string,
  topMinimum: number,
  topMaximum: number,
): boolean {
  return blocks.some((block) => {
    const centerTop = page.height - (block.box.bottom + block.box.top) / 2;
    return normalizeEvidenceText(block.text).includes(anchor) && centerTop >= topMinimum && centerTop <= topMaximum;
  });
}
