import { EngineError } from "./errors";
import { openPdfRenderer } from "./render";
import {
  contains,
  intersects,
  structuralBorderTopPositions,
  templateRegions,
} from "./template";
import { findTemplateDefinition, type TemplateDefinition } from "./templates";
import type { Analysis, Detection, Extraction, ExtractedRegion, Extractor, PdfRect } from "./types";

function meaningful(value: string): boolean {
  return value.replace(/[^\p{L}\p{N}]/gu, "").length > 0;
}

function evidenceBoxes(definition: TemplateDefinition, page: Detection["pages"][number]): Array<{ text: string; box: PdfRect }> {
  if (page.kind === "scanned") return page.ocrBlocks;
  return [
    ...page.textItems,
    ...page.imageBoxes.map((box) => ({ text: "image", box })),
    ...meaningfulPathBoxes(definition, page).map((box) => ({ text: "path", box })),
  ];
}

function meaningfulPathBoxes(definition: TemplateDefinition, page: Detection["pages"][number]): PdfRect[] {
  const knownBorders = structuralBorderTopPositions(definition, page.role).map((top) => page.height - top);
  return page.pathBoxes.filter((box) => {
    const thinHorizontal = box.top - box.bottom <= 1 && box.right - box.left >= page.width * 0.9;
    const knownStructuralBorder = thinHorizontal && knownBorders.some((y) =>
      Math.abs(y - box.top) <= 0.75 && Math.abs(y - box.bottom) <= 0.75,
    );
    return !knownStructuralBorder;
  });
}

type PageBounds = TemplateDefinition["page"];

function enclosingBox(boxes: PdfRect[], bounds: PageBounds): PdfRect {
  return {
    left: Math.max(0, Math.min(...boxes.map((box) => box.left)) - 2),
    bottom: Math.max(0, Math.min(...boxes.map((box) => box.bottom)) - 2),
    right: Math.min(bounds.widthPt, Math.max(...boxes.map((box) => box.right)) + 2),
    top: Math.min(bounds.heightPt, Math.max(...boxes.map((box) => box.top)) + 2),
  };
}

function verticalGap(first: PdfRect, second: PdfRect): number {
  if (first.bottom > second.top) return first.bottom - second.top;
  if (second.bottom > first.top) return second.bottom - first.top;
  return 0;
}

function clusterBoxes(boxes: PdfRect[], bounds: PageBounds): PdfRect[][] {
  const clusters: PdfRect[][] = [];
  for (const box of [...boxes].sort((first, second) => second.top - first.top)) {
    const cluster = clusters.find((candidate) => verticalGap(enclosingBox(candidate, bounds), box) <= 4);
    if (cluster) cluster.push(box);
    else clusters.push([box]);
  }
  return clusters;
}

function mergeOverlappingRegions<T extends { box: PdfRect }>(regions: T[]): T[] {
  const merged: T[] = [];
  for (const region of [...regions].sort((first, second) => second.box.top - first.box.top)) {
    const previous = merged.at(-1);
    if (previous && intersects(previous.box, region.box)) {
      previous.box = {
        left: Math.min(previous.box.left, region.box.left),
        bottom: Math.min(previous.box.bottom, region.box.bottom),
        right: Math.max(previous.box.right, region.box.right),
        top: Math.max(previous.box.top, region.box.top),
      };
    } else {
      merged.push(region);
    }
  }
  return merged;
}

async function scannedInkBoxes(analysis: Analysis, page: Detection["pages"][number]): Promise<PdfRect[]> {
  const renderer = await openPdfRenderer(analysis.bytes);
  try {
    const bitmap = await renderer.render(page.pageNumber, 203, 0);
    const dark = new Uint8Array(bitmap.width * bitmap.height);
    for (let y = 0; y < bitmap.height; y += 1) {
      for (let x = 0; x < bitmap.width; x += 1) {
        const offset = (y * bitmap.width + x) * 4;
        const alpha = bitmap.rgba[offset + 3] / 255;
        const luminance = (bitmap.rgba[offset] + bitmap.rgba[offset + 1] * 2 + bitmap.rgba[offset + 2]) / 4;
        if (alpha > 0.5 && luminance < 245) dark[y * bitmap.width + x] = 1;
      }
    }

    const structuralRows = new Set<number>();
    let rowStart = -1;
    for (let y = 0; y <= bitmap.height; y += 1) {
      let count = 0;
      if (y < bitmap.height) for (let x = 0; x < bitmap.width; x += 1) count += dark[y * bitmap.width + x];
      if (count / bitmap.width >= 0.9) {
        if (rowStart < 0) rowStart = y;
      } else if (rowStart >= 0) {
        if (y - rowStart <= 3) for (let row = rowStart; row < y; row += 1) structuralRows.add(row);
        rowStart = -1;
      }
    }
    const structuralColumns = new Set<number>();
    let columnStart = -1;
    for (let x = 0; x <= bitmap.width; x += 1) {
      let count = 0;
      if (x < bitmap.width) for (let y = 0; y < bitmap.height; y += 1) count += dark[y * bitmap.width + x];
      if (count / bitmap.height >= 0.9) {
        if (columnStart < 0) columnStart = x;
      } else if (columnStart >= 0) {
        if (x - columnStart <= 3) for (let column = columnStart; column < x; column += 1) structuralColumns.add(column);
        columnStart = -1;
      }
    }
    const active = Array.from({ length: bitmap.height }, (_, y) => {
      if (structuralRows.has(y)) return false;
      for (let x = 0; x < bitmap.width; x += 1) {
        if (!structuralColumns.has(x) && dark[y * bitmap.width + x]) return true;
      }
      return false;
    });
    const runs: Array<readonly [number, number]> = [];
    let start = -1;
    let lastActive = -1;
    for (let y = 0; y <= active.length; y += 1) {
      if (active[y]) {
        if (start < 0) start = y;
        lastActive = y;
      } else if (start >= 0 && y - lastActive > 3) {
        if (lastActive - start >= 1) runs.push([start, lastActive + 1]);
        start = -1;
        lastActive = -1;
      }
    }
    if (start >= 0 && lastActive >= start && lastActive - start >= 1) runs.push([start, lastActive + 1]);
    return runs.map(([topPixel, bottomPixel]) => ({
      left: 0,
      right: page.width,
      top: page.height - topPixel * page.height / bitmap.height,
      bottom: page.height - bottomPixel * page.height / bitmap.height,
    }));
  } finally {
    await renderer.close();
  }
}

/** Extracts the useful regions of whichever registered layout the detector matched. */
export class TemplateExtractor implements Extractor {
  async extract(analysis: Analysis, detection: Detection): Promise<Extraction> {
    const definition = findTemplateDefinition(detection.templateKey, detection.templateVersion);
    if (!definition) throw new EngineError("unsupported_template");
    const logistics = detection.pages.find((page) => page.role === "logistics");
    const danfe = detection.pages.find((page) => page.role === "danfe");
    if (!logistics || !danfe) throw new EngineError("ambiguous_template");
    const protectedCodes = definition.protectedCodes(logistics.pageNumber, danfe.pageNumber);
    const regions: ExtractedRegion[] = [];
    const contentBoxes: Extraction["contentBoxes"] = [];

    for (const page of [logistics, danfe]) {
      const pageRegions = templateRegions(definition, page.role, page.pageNumber);
      const evidence = evidenceBoxes(definition, page).filter((item) => meaningful(item.text));
      const inkBoxes = page.kind === "scanned" ? await scannedInkBoxes(analysis, page) : [];
      evidence.push(...inkBoxes.map((box) => ({ text: "rendered-ink", box })));
      contentBoxes.push(
        ...page.textItems.map((item) => ({ pageNumber: page.pageNumber, kind: "text" as const, box: item.box })),
        ...(page.kind === "digital" ? page.imageBoxes : []).map((box) => ({ pageNumber: page.pageNumber, kind: "image" as const, box })),
        ...(page.kind === "digital" ? meaningfulPathBoxes(definition, page) : []).map((box) => ({ pageNumber: page.pageNumber, kind: "ink" as const, box })),
        ...inkBoxes.map((box) => ({ pageNumber: page.pageNumber, kind: "ink" as const, box })),
      );
      const initiallyUncovered = evidence.filter((item) => !pageRegions.some((region) => contains(region.box, item.box, 0.2)));
      const dynamicBoxes: PdfRect[] = [];
      for (const item of initiallyUncovered) {
        const nearest = [...pageRegions].sort((first, second) => verticalGap(first.box, item.box) - verticalGap(second.box, item.box))[0];
        if (nearest && verticalGap(nearest.box, item.box) <= 4) nearest.box = enclosingBox([nearest.box, item.box], definition.page);
        else dynamicBoxes.push(item.box);
      }
      for (const [index, cluster] of clusterBoxes(dynamicBoxes, definition.page).entries()) {
        pageRegions.push({
          id: `${page.role}_additional_dynamic_${index + 1}`,
          pageNumber: page.pageNumber,
          role: page.role,
          box: enclosingBox(cluster, definition.page),
        });
      }
      for (const region of mergeOverlappingRegions(pageRegions)) {
        const hasText = evidence.some((item) => intersects(region.box, item.box));
        const hasCode = protectedCodes.some((code) => code.pageNumber === page.pageNumber && contains(region.box, code.box, 1));
        const populated = hasText || hasCode;
        if (!populated) throw new EngineError("missing_required_region");
        regions.push({ ...region, populated });
      }
    }

    const fiscalSummary = definition.compactFiscal?.summarize(danfe);
    return { analysis, detection, regions, protectedCodes, contentBoxes, ...(fiscalSummary ? { fiscalSummary } : {}) };
  }
}

export const extractContent = (analysis: Analysis, detection: Detection) =>
  new TemplateExtractor().extract(analysis, detection);
