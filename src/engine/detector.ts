import { EngineError } from "./errors";
import { recognizeScannedPage } from "./ocr";
import { openPdfRenderer, type RenderedBitmap } from "./render";
import { listTemplateDefinitions, normalizeEvidenceText, selectTemplateDefinitions, type TemplateDefinition } from "./templates";
import type { Analysis, DetectedPage, Detection, Detector, OcrBlock, PageRole } from "./types";

function protectedInk(bitmap: RenderedBitmap, box: { left: number; bottom: number; right: number; top: number }, pageWidth: number, pageHeight: number): boolean {
  const scaleX = bitmap.width / pageWidth;
  const scaleY = bitmap.height / pageHeight;
  const left = Math.max(0, Math.floor(box.left * scaleX));
  const right = Math.min(bitmap.width, Math.ceil(box.right * scaleX));
  const top = Math.max(0, Math.floor((pageHeight - box.top) * scaleY));
  const bottom = Math.min(bitmap.height, Math.ceil((pageHeight - box.bottom) * scaleY));
  let dark = 0;
  let sampled = 0;
  for (let y = top; y < bottom; y += 2) {
    for (let x = left; x < right; x += 2) {
      const offset = (y * bitmap.width + x) * 4;
      const luminance = (bitmap.rgba[offset] + bitmap.rgba[offset + 1] * 2 + bitmap.rgba[offset + 2]) / 4;
      if (luminance < 200) dark += 1;
      sampled += 1;
    }
  }
  return sampled > 0 && dark / sampled >= 0.015;
}

async function verifyProtectedGeometry(definition: TemplateDefinition, analysis: Analysis, logisticsPage: number, danfePage: number): Promise<void> {
  const codes = definition.protectedCodes(logisticsPage, danfePage);
  const digitalGeometryValid = codes.every((code) => {
    const page = analysis.pages.find((candidate) => candidate.pageNumber === code.pageNumber);
    if (!page || page.kind !== "digital") return true;
    const imageMatch = page.imageBoxes.some((box) =>
      box.left < code.box.right && box.right > code.box.left && box.bottom < code.box.top && box.top > code.box.bottom,
    );
    const pathCount = page.pathBoxes.filter((box) =>
      box.left < code.box.right && box.right > code.box.left && box.bottom < code.box.top && box.top > code.box.bottom,
    ).length;
    return imageMatch || pathCount >= 5;
  });
  if (!digitalGeometryValid) throw new EngineError("unsupported_template");
  if (analysis.pages.every((page) => page.kind === "digital")) return;

  const renderer = await openPdfRenderer(analysis.bytes);
  try {
    const bitmaps = new Map<number, RenderedBitmap>();
    for (const code of codes) {
      const analyzedPage = analysis.pages.find((candidate) => candidate.pageNumber === code.pageNumber);
      if (analyzedPage?.kind === "digital") continue;
      let bitmap = bitmaps.get(code.pageNumber);
      if (!bitmap) {
        bitmap = await renderer.render(code.pageNumber, 203, 0);
        bitmaps.set(code.pageNumber, bitmap);
      }
      if (!analyzedPage || !protectedInk(bitmap, code.box, definition.page.widthPt, analyzedPage.height)) throw new EngineError("unsupported_template");
    }
  } finally {
    await renderer.close();
  }
}

function pagesFit(definition: TemplateDefinition, analysis: Analysis): boolean {
  return analysis.pages.every((page) =>
    Math.abs(page.width - definition.page.widthPt) <= definition.page.tolerancePt &&
    Math.abs(page.height - definition.page.heightPt) <= definition.page.tolerancePt);
}

/**
 * Matches the analyzed pair against every registered layout. Exactly one
 * layout and page order may match; anything else is rejected rather than
 * composed with a best-effort guess.
 */
export class TemplateDetector implements Detector {
  constructor(private readonly definitions: readonly TemplateDefinition[] = listTemplateDefinitions()) {}

  async detect(analysis: Analysis, selectedTemplate?: string): Promise<Detection> {
    const definitions = selectTemplateDefinitions(selectedTemplate, this.definitions);
    const evidence = await Promise.all(analysis.pages.map(async (page) => {
      const ocrBlocks: OcrBlock[] = page.kind === "scanned"
        ? await recognizeScannedPage(analysis.bytes, page)
        : [];
      const text = normalizeEvidenceText(page.kind === "scanned" ? ocrBlocks.map((block) => block.text).join(" ") : page.text);
      const blocks = page.kind === "scanned" ? ocrBlocks : page.textItems;
      return { page, text, ocrBlocks, blocks };
    }));

    const candidates = definitions.filter((definition) => pagesFit(definition, analysis)).flatMap((definition) => {
      const scored = evidence.map((item) => ({ ...item, scores: definition.scoreRoles(item.text) }));
      return [
        { definition, logistics: scored[0], danfe: scored[1] },
        { definition, logistics: scored[1], danfe: scored[0] },
      ].filter((candidate) =>
        candidate.logistics.scores.logistics >= definition.minimumScores.logistics &&
        candidate.danfe.scores.danfe >= definition.minimumScores.danfe &&
        definition.matchesRoleGeometry(candidate.logistics.page, candidate.logistics.blocks, "logistics") &&
        definition.matchesRoleGeometry(candidate.danfe.page, candidate.danfe.blocks, "danfe"));
    });
    if (candidates.length === 0) throw new EngineError("unsupported_template");
    if (candidates.length > 1) throw new EngineError("ambiguous_template");
    const match = candidates[0];
    await verifyProtectedGeometry(match.definition, analysis, match.logistics.page.pageNumber, match.danfe.page.pageNumber);
    const pages = analysis.pages.map((page) => {
      const matched = evidence.find((item) => item.page.pageNumber === page.pageNumber)!;
      const role: PageRole = page.pageNumber === match.logistics.page.pageNumber ? "logistics" : "danfe";
      return { ...page, role, evidence: "template-anchors", ocrBlocks: matched.ocrBlocks } satisfies DetectedPage;
    }) as [DetectedPage, DetectedPage];
    return { templateKey: match.definition.key, templateVersion: match.definition.version, pages };
  }
}

export const detectTemplate = (analysis: Analysis, selectedTemplate?: string) =>
  new TemplateDetector().detect(analysis, selectedTemplate);
