import { PDFDocument } from "pdf-lib";

import { decodeCode, type PixelRegion } from "./barcodes";
import { EngineError } from "./errors";
import { openPdfRenderer, type RenderedBitmap } from "./render";
import type { ComposedPdf, PdfRect, ValidationResult, Validator } from "./types";

export const VALIDATION_POLICY = {
  codesDpi: [203, 300],
  pixelContentDpi: [203],
} as const;

function pixelRegion(box: PdfRect, pageHeightPt: number, dpi: number, bitmap: RenderedBitmap, padding = 2): PixelRegion {
  const scale = dpi / 72;
  const left = Math.max(0, Math.floor(box.left * scale) - padding);
  const top = Math.max(0, Math.floor((pageHeightPt - box.top) * scale) - padding);
  const right = Math.min(bitmap.width, Math.ceil(box.right * scale) + padding);
  const bottom = Math.min(bitmap.height, Math.ceil((pageHeightPt - box.bottom) * scale) + padding);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function insidePage(box: PdfRect, width: number, height: number): boolean {
  return box.left >= -0.5 && box.bottom >= -0.5 && box.right <= width + 0.5 && box.top <= height + 0.5 &&
    box.right > box.left && box.top > box.bottom;
}

function isDark(bitmap: RenderedBitmap, x: number, y: number, threshold: number): boolean {
  const offset = (y * bitmap.width + x) * 4;
  return (bitmap.rgba[offset] + bitmap.rgba[offset + 1] * 2 + bitmap.rgba[offset + 2]) / 4 < threshold;
}

function outputHasInk(bitmap: RenderedBitmap, x: number, y: number): boolean {
  for (let offsetY = -2; offsetY <= 2; offsetY += 1) {
    for (let offsetX = -2; offsetX <= 2; offsetX += 1) {
      const targetX = x + offsetX;
      const targetY = y + offsetY;
      if (targetX >= 0 && targetX < bitmap.width && targetY >= 0 && targetY < bitmap.height &&
        isDark(bitmap, targetX, targetY, 230)) return true;
    }
  }
  return false;
}

function assertRegionPixelsPreserved(
  source: RenderedBitmap,
  sourceRegion: PixelRegion,
  output: RenderedBitmap,
  outputRegion: PixelRegion,
): void {
  const visited = new Uint8Array(sourceRegion.width * sourceRegion.height);
  const localDark = (x: number, y: number) => isDark(source, sourceRegion.x + x, sourceRegion.y + y, 180);
  for (let startY = 0; startY < sourceRegion.height; startY += 1) {
    for (let startX = 0; startX < sourceRegion.width; startX += 1) {
      const startIndex = startY * sourceRegion.width + startX;
      if (visited[startIndex] || !localDark(startX, startY)) continue;
      const queue: Array<readonly [number, number]> = [[startX, startY]];
      visited[startIndex] = 1;
      let total = 0;
      let matched = 0;
      let touchesCropBoundary = false;
      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const [x, y] = queue[cursor];
        total += 1;
        if (x <= 1 || y <= 1 || x >= sourceRegion.width - 2 || y >= sourceRegion.height - 2) touchesCropBoundary = true;
        const targetX = outputRegion.x + Math.round(x * outputRegion.width / sourceRegion.width);
        const targetY = outputRegion.y + Math.round(y * outputRegion.height / sourceRegion.height);
        if (outputHasInk(output, targetX, targetY)) matched += 1;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nextX = x + dx;
            const nextY = y + dy;
            if ((dx === 0 && dy === 0) || nextX < 0 || nextY < 0 ||
              nextX >= sourceRegion.width || nextY >= sourceRegion.height) continue;
            const nextIndex = nextY * sourceRegion.width + nextX;
            if (!visited[nextIndex] && localDark(nextX, nextY)) {
              visited[nextIndex] = 1;
              queue.push([nextX, nextY]);
            }
          }
        }
      }
      if (!touchesCropBoundary && total >= 2 && matched / total < 0.65) throw new EngineError("validation_failed");
    }
  }
}

export class RenderedPdfValidator implements Validator {
  async validate(composed: ComposedPdf): Promise<ValidationResult> {
    const { layout } = composed;
    try {
      const structural = await PDFDocument.load(composed.bytes, { updateMetadata: false });
      if (structural.getPageCount() !== 1) throw new EngineError("validation_failed");
      const outputPage = structural.getPage(0);
      if (Math.abs(outputPage.getWidth() - layout.widthPt) > 1 || Math.abs(outputPage.getHeight() - layout.heightPt) > 1) {
        throw new EngineError("validation_failed");
      }
      if (layout.regions.some((region) => !insidePage(region.outputBox, layout.widthPt, layout.heightPt)) ||
        layout.protectedCodes.some((code) => !insidePage(code.outputBox, layout.widthPt, layout.heightPt))) {
        throw new EngineError("validation_failed");
      }
      const uncoveredContent = layout.extraction.contentBoxes.some((content) =>
        !layout.regions.some((region) => region.pageNumber === content.pageNumber &&
          content.box.left >= region.box.left - 0.2 && content.box.right <= region.box.right + 0.2 &&
          content.box.bottom >= region.box.bottom - 0.2 && content.box.top <= region.box.top + 0.2),
      );
      if (uncoveredContent) throw new EngineError("validation_failed");

      const sourceRenderer = await openPdfRenderer(layout.extraction.analysis.bytes);
      const outputRenderer = await openPdfRenderer(composed.bytes);
      try {
        for (const dpi of VALIDATION_POLICY.codesDpi) {
          const outputBitmap = await outputRenderer.render(1, dpi, 0);
          const sourceBitmaps = new Map<number, RenderedBitmap>();
          if (VALIDATION_POLICY.pixelContentDpi.some((contentDpi) => contentDpi === dpi)) {
            for (const region of layout.regions) {
              let sourceBitmap = sourceBitmaps.get(region.pageNumber);
              if (!sourceBitmap) {
                sourceBitmap = await sourceRenderer.render(region.pageNumber, dpi, 0);
                sourceBitmaps.set(region.pageNumber, sourceBitmap);
              }
              const sourcePage = layout.extraction.analysis.pages.find((page) => page.pageNumber === region.pageNumber);
              if (!sourcePage) throw new EngineError("validation_failed");
              assertRegionPixelsPreserved(
                sourceBitmap,
                pixelRegion(region.box, sourcePage.height, dpi, sourceBitmap, 0),
                outputBitmap,
                pixelRegion(region.outputBox, layout.heightPt, dpi, outputBitmap, 0),
              );
            }
          }
          for (const code of layout.protectedCodes) {
            let sourceBitmap = sourceBitmaps.get(code.pageNumber);
            if (!sourceBitmap) {
              sourceBitmap = await sourceRenderer.render(code.pageNumber, dpi, 0);
              sourceBitmaps.set(code.pageNumber, sourceBitmap);
            }
            const sourcePage = layout.extraction.analysis.pages.find((page) => page.pageNumber === code.pageNumber);
            if (!sourcePage) throw new EngineError("validation_failed");
            let inputValue: string;
            let outputValue: string;
            try {
              inputValue = decodeCode(sourceBitmap, pixelRegion(code.box, sourcePage.height, dpi, sourceBitmap), code.format);
              outputValue = decodeCode(outputBitmap, pixelRegion(code.outputBox, layout.heightPt, dpi, outputBitmap), code.format);
            } catch {
              throw new EngineError("codes_unreadable");
            }
            if (inputValue !== outputValue) throw new EngineError("validation_failed");
          }
        }
      } finally {
        await Promise.allSettled([sourceRenderer.close(), outputRenderer.close()]);
      }
      return { contentPreserved: true, geometryValid: true, codesEquivalent: true };
    } catch (error) {
      if (error instanceof EngineError) throw error;
      throw new EngineError("validation_failed");
    }
  }
}

export const validatePdf = (composed: ComposedPdf) => new RenderedPdfValidator().validate(composed);
