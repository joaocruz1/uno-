import { EngineError } from "./errors";
import { recognizeScannedPage } from "./ocr";
import { openPdfRenderer, type RenderedBitmap } from "./render";
import { templateProtectedCodes } from "./template";
import { TEMPLATE_KEY, TEMPLATE_VERSION, type Analysis, type DetectedPage, type Detection, type Detector, type OcrBlock, type PageRole } from "./types";

function normalized(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/\s+/g, " ");
}

function scores(text: string): Record<PageRole, number> {
  const value = normalized(text);
  return {
    logistics: (value.includes("DESPACHAR") ? 3 : 0) + (value.includes("ROTA") ? 2 : 0) +
      (value.includes("DESTINATARIO") ? 1 : 0),
    danfe: (value.includes("DANFE") ? 3 : 0) + (value.includes("CHAVE DE ACESSO") ? 3 : 0) +
      (value.includes("DOCUMENTO AUXILIAR") ? 1 : 0),
  };
}

function anchorAt(
  page: Analysis["pages"][number],
  blocks: Array<{ text: string; box: { bottom: number; top: number } }>,
  anchor: string,
  topMinimum: number,
  topMaximum: number,
): boolean {
  return blocks.some((block) => {
    const centerTop = page.height - (block.box.bottom + block.box.top) / 2;
    return normalized(block.text).includes(anchor) && centerTop >= topMinimum && centerTop <= topMaximum;
  });
}

function roleGeometry(page: Analysis["pages"][number], blocks: Array<{ text: string; box: { bottom: number; top: number } }>, role: PageRole): boolean {
  if (role === "logistics") {
    const hasHeaderIdentifier = blocks.some((block) => {
      const centerTop = page.height - (block.box.bottom + block.box.top) / 2;
      return centerTop >= 0 && centerTop <= 60 && normalized(block.text).replace(/[^A-Z0-9]/g, "").length >= 4;
    });
    return hasHeaderIdentifier && anchorAt(page, blocks, "DESPACHAR", 65, 95);
  }
  return anchorAt(page, blocks, "CHAVE", 0, 46) &&
    anchorAt(page, blocks, "REMETENTE", 125, 158) &&
    anchorAt(page, blocks, "DESTINATARIO", 155, 185) &&
    anchorAt(page, blocks, "DANFE", 170, 205);
}

function protectedInk(bitmap: RenderedBitmap, box: { left: number; bottom: number; right: number; top: number }, pageHeight: number): boolean {
  const scaleX = bitmap.width / 283.4646;
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

async function verifyProtectedGeometry(analysis: Analysis, logisticsPage: number, danfePage: number): Promise<void> {
  const codes = templateProtectedCodes(logisticsPage, danfePage);
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
      if (!analyzedPage || !protectedInk(bitmap, code.box, analyzedPage.height)) throw new EngineError("unsupported_template");
    }
  } finally {
    await renderer.close();
  }
}

function verifySelection(selected?: string): void {
  if (!selected) return;
  if (![TEMPLATE_KEY, `${TEMPLATE_KEY}@${TEMPLATE_VERSION}`, `${TEMPLATE_KEY}:${TEMPLATE_VERSION}`].includes(selected)) {
    throw new EngineError("unsupported_template");
  }
}

export class MercadoLivreDetector implements Detector {
  async detect(analysis: Analysis, selectedTemplate?: string): Promise<Detection> {
    verifySelection(selectedTemplate);
    const evidence = await Promise.all(analysis.pages.map(async (page) => {
      const ocrBlocks: OcrBlock[] = page.kind === "scanned"
        ? await recognizeScannedPage(analysis.bytes, page)
        : [];
      const text = page.kind === "scanned" ? ocrBlocks.map((block) => block.text).join(" ") : page.text;
      const blocks = page.kind === "scanned" ? ocrBlocks : page.textItems;
      return { page, text, ocrBlocks, blocks, scores: scores(text) };
    }));

    const candidates = [
      { logistics: evidence[0], danfe: evidence[1] },
      { logistics: evidence[1], danfe: evidence[0] },
    ].filter((candidate) => candidate.logistics.scores.logistics >= 3 && candidate.danfe.scores.danfe >= 4 &&
      roleGeometry(candidate.logistics.page, candidate.logistics.blocks, "logistics") &&
      roleGeometry(candidate.danfe.page, candidate.danfe.blocks, "danfe"));
    if (candidates.length === 0) throw new EngineError("unsupported_template");
    if (candidates.length > 1) throw new EngineError("ambiguous_template");
    const match = candidates[0];
    await verifyProtectedGeometry(analysis, match.logistics.page.pageNumber, match.danfe.page.pageNumber);
    const pages = analysis.pages.map((page) => {
      const matched = evidence.find((item) => item.page.pageNumber === page.pageNumber)!;
      const role: PageRole = page.pageNumber === match.logistics.page.pageNumber ? "logistics" : "danfe";
      return { ...page, role, evidence: "template-anchors", ocrBlocks: matched.ocrBlocks } satisfies DetectedPage;
    }) as [DetectedPage, DetectedPage];
    return { templateKey: TEMPLATE_KEY, templateVersion: TEMPLATE_VERSION, pages };
  }
}

export const detectTemplate = (analysis: Analysis, selectedTemplate?: string) =>
  new MercadoLivreDetector().detect(analysis, selectedTemplate);
