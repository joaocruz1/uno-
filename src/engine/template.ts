import type { PageRole, PdfRect, ProtectedCodeRegion } from "./types";

export const PAGE_WIDTH_PT = 283.4646;
export const PAGE_HEIGHT_PT = 425.1969;
export const DIMENSION_TOLERANCE_PT = 1;

const TOP_DOWN_BANDS: Record<PageRole, ReadonlyArray<readonly [number, number]>> = {
  logistics: [[4, 56], [66, 91], [94, 176], [205, 246], [255, 293], [307, 421]],
  danfe: [[5, 46], [53, 126], [132, 153], [161, 202], [329, 340]],
};

const STRUCTURAL_OUTER_FRAME: PdfRect = {
  left: 8.5039,
  bottom: 2.8346,
  right: 264.1889,
  top: 424.3464,
};

export function isTemplateOuterFrame(box: PdfRect): boolean {
  return Math.abs(box.left - STRUCTURAL_OUTER_FRAME.left) <= 0.75 &&
    Math.abs(box.bottom - STRUCTURAL_OUTER_FRAME.bottom) <= 0.75 &&
    Math.abs(box.right - STRUCTURAL_OUTER_FRAME.right) <= 0.75 &&
    Math.abs(box.top - STRUCTURAL_OUTER_FRAME.top) <= 0.75;
}

export function structuralBorderTopPositions(role: PageRole): number[] {
  return [...new Set(TOP_DOWN_BANDS[role].flatMap(([top, bottom]) => [top, bottom]))];
}

export function bandBox(top: number, bottom: number): PdfRect {
  return { left: 0, bottom: PAGE_HEIGHT_PT - bottom, right: PAGE_WIDTH_PT, top: PAGE_HEIGHT_PT - top };
}

export function templateRegions(role: PageRole, pageNumber: number) {
  return TOP_DOWN_BANDS[role].map(([top, bottom], index) => ({
    id: `${role}_${index + 1}`,
    pageNumber,
    role,
    box: bandBox(top, bottom),
  }));
}

export function templateProtectedCodes(logisticsPage: number, danfePage: number): ProtectedCodeRegion[] {
  return [
    {
      id: "logistics_barcode",
      pageNumber: logisticsPage,
      format: "CODE_128",
      box: { left: 37.1339, bottom: 270.9921, right: 207.2126, top: 327.685 },
    },
    {
      id: "logistics_qr",
      pageNumber: logisticsPage,
      format: "QR_CODE",
      box: { left: 167.5276, bottom: 29.4803, right: 252.567, top: 114.5197 },
    },
    {
      id: "danfe_barcode",
      pageNumber: danfePage,
      format: "CODE_128",
      box: { left: 20.126, bottom: 312.0384, right: 246.8977, top: 368.7313 },
    },
  ];
}

export function contains(outer: PdfRect, inner: PdfRect, tolerance = 1): boolean {
  return inner.left >= outer.left - tolerance && inner.right <= outer.right + tolerance &&
    inner.bottom >= outer.bottom - tolerance && inner.top <= outer.top + tolerance;
}

export function intersects(a: PdfRect, b: PdfRect): boolean {
  return a.left < b.right && a.right > b.left && a.bottom < b.top && a.top > b.bottom;
}
