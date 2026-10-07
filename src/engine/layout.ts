import { EngineError } from "./errors";
import type { Extraction, Layout, LayoutPlan, OutputSize, PageRole, PdfRect } from "./types";

const POINTS_PER_MM = 72 / 25.4;
const MARGIN_PT = 6;
const GAP_PT = 1;

function dimensions(outputSize: OutputSize): { widthMm: number; heightMm: number } {
  if (outputSize.preset === "custom") {
    if (!Number.isFinite(outputSize.widthMm) || !Number.isFinite(outputSize.heightMm) ||
      outputSize.widthMm < 50 || outputSize.widthMm > 210 || outputSize.heightMm < 50 || outputSize.heightMm > 300) {
      throw new EngineError("format_too_small");
    }
    return outputSize;
  }
  if (outputSize.preset === "100x150") return { widthMm: 100, heightMm: 150 };
  if (outputSize.preset === "100x100") return { widthMm: 100, heightMm: 100 };
  return { widthMm: 105, heightMm: 148 };
}

function height(box: PdfRect): number {
  return box.top - box.bottom;
}

function roleOrder(role: PageRole): number {
  return role === "logistics" ? 0 : 1;
}

export class SafeLayoutEngine implements Layout {
  async layout(extraction: Extraction, outputSize: OutputSize): Promise<LayoutPlan> {
    const { widthMm, heightMm } = dimensions(outputSize);
    const widthPt = widthMm * POINTS_PER_MM;
    const heightPt = heightMm * POINTS_PER_MM;
    const regions = [...extraction.regions].sort((a, b) =>
      roleOrder(a.role) - roleOrder(b.role) || b.box.top - a.box.top,
    );
    const widest = Math.max(...regions.map((region) => region.box.right - region.box.left));
    const usefulHeight = regions.reduce((total, region) => total + height(region.box), 0);
    const requiredHeight = usefulHeight + MARGIN_PT * 2 + GAP_PT * Math.max(0, regions.length - 1);
    if (widthPt + 0.5 < widest || heightPt + 0.5 < requiredHeight) {
      throw new EngineError("format_too_small");
    }

    let cursorTop = heightPt - MARGIN_PT;
    const placed = regions.map((region) => {
      const regionWidth = region.box.right - region.box.left;
      const regionHeight = height(region.box);
      const left = (widthPt - regionWidth) / 2;
      const outputBox = { left, bottom: cursorTop - regionHeight, right: left + regionWidth, top: cursorTop };
      cursorTop = outputBox.bottom - GAP_PT;
      return { ...region, outputBox };
    });

    const protectedCodes = extraction.protectedCodes.map((code) => {
      const container = placed.find((region) => region.pageNumber === code.pageNumber &&
        code.box.left >= region.box.left - 1 && code.box.right <= region.box.right + 1 &&
        code.box.bottom >= region.box.bottom - 1 && code.box.top <= region.box.top + 1);
      if (!container) throw new EngineError("missing_required_region");
      const outputBox = {
        left: container.outputBox.left + code.box.left - container.box.left,
        right: container.outputBox.left + code.box.right - container.box.left,
        bottom: container.outputBox.bottom + code.box.bottom - container.box.bottom,
        top: container.outputBox.bottom + code.box.top - container.box.bottom,
      };
      return { ...code, outputBox };
    });

    return { extraction, widthMm, heightMm, widthPt, heightPt, scale: 1, regions: placed, protectedCodes };
  }
}

export const createLayout = (extraction: Extraction, outputSize: OutputSize) =>
  new SafeLayoutEngine().layout(extraction, outputSize);
