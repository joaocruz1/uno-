import type { AnalyzedPage, FiscalSummary, PageRole, PdfRect, ProtectedCodeRegion } from "../types";

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
