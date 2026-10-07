import { listTemplateDefinitions, type TemplateDefinition } from "./templates";
import type { PageRole, PdfRect } from "./types";

const FRAME_TOLERANCE_PT = 0.75;

export function supportedPageDimensions(
  width: number,
  height: number,
  definitions: readonly TemplateDefinition[] = listTemplateDefinitions(),
): boolean {
  return definitions.some(({ page }) =>
    Math.abs(width - page.widthPt) <= page.tolerancePt && Math.abs(height - page.heightPt) <= page.tolerancePt);
}

export function isTemplateOuterFrame(
  box: PdfRect,
  definitions: readonly TemplateDefinition[] = listTemplateDefinitions(),
): boolean {
  return definitions.some(({ structuralOuterFrame: frame }) => frame !== undefined &&
    Math.abs(box.left - frame.left) <= FRAME_TOLERANCE_PT &&
    Math.abs(box.bottom - frame.bottom) <= FRAME_TOLERANCE_PT &&
    Math.abs(box.right - frame.right) <= FRAME_TOLERANCE_PT &&
    Math.abs(box.top - frame.top) <= FRAME_TOLERANCE_PT);
}

export function structuralBorderTopPositions(definition: TemplateDefinition, role: PageRole): number[] {
  return [...new Set(definition.bands[role].flatMap(([top, bottom]) => [top, bottom]))];
}

export function bandBox(definition: TemplateDefinition, top: number, bottom: number): PdfRect {
  return { left: 0, bottom: definition.page.heightPt - bottom, right: definition.page.widthPt, top: definition.page.heightPt - top };
}

export function templateRegions(definition: TemplateDefinition, role: PageRole, pageNumber: number) {
  return definition.bands[role].map(([top, bottom], index) => ({
    id: `${role}_${index + 1}`,
    pageNumber,
    role,
    box: bandBox(definition, top, bottom),
  }));
}

export function contains(outer: PdfRect, inner: PdfRect, tolerance = 1): boolean {
  return inner.left >= outer.left - tolerance && inner.right <= outer.right + tolerance &&
    inner.bottom >= outer.bottom - tolerance && inner.top <= outer.top + tolerance;
}

export function intersects(a: PdfRect, b: PdfRect): boolean {
  return a.left < b.right && a.right > b.left && a.bottom < b.top && a.top > b.bottom;
}
