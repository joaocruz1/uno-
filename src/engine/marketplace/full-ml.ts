import bwipjs from "bwip-js/node";
import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from "pdf-lib";

import { decodeCode } from "../barcodes";
import { openPdfRenderer } from "../render";
import { concatPdfs, stampTopLeftNumber } from "./pdf";
import type { LabelNumbering, MarketplaceBatchResult, OrderOutcome } from "./types";
import { preprocessZpl, ZplError, type ZplBlock } from "./zpl";

/** ZPL dots are 8 per mm at the Full label's native density; map a dot to points. */
const DOT_TO_PT = 72 / (25.4 * 8);
const DEFAULT_MAX_LABELS = 500;

/** Keeps only WinAnsi-encodable characters so a stray glyph never throws mid-draw. */
function safe(text: string): string {
  return text.replace(/[‘’‚‛]/g, "'").replace(/[“”„]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "...").replace(/[^\x20-\x7E -ÿ]/g, "");
}

type DrawState = { x: number; y: number; fontDots: number; barcode: { heightDots: number } | null };

/** Commands that draw content we do not render yet: refusing keeps a label from
 * printing without its barcode or graphic, rather than silently dropping it. */
function isUnsupportedDrawCommand(code: string): boolean {
  if (code === "GF" || code === "XG") return true; // recalled/stored graphics
  // Any ^B… barcode other than Code128 (^BC) or its defaults (^BY).
  return code.startsWith("B") && code !== "BC" && code !== "BY";
}

async function barcodePng(data: string): Promise<{ png: Buffer; width: number; height: number }> {
  const png = await bwipjs.toBuffer({ bcid: "code128", text: data, scale: 3, height: 16, includetext: false, paddingwidth: 0, paddingheight: 0 });
  const doc = await PDFDocument.create();
  const image = await doc.embedPng(png);
  return { png, width: image.width, height: image.height };
}

/**
 * Parses one ^XA…^XZ block and draws it onto a PDF page sized from ^PW/^LL.
 * Handles the Mercado Livre Full subset — ^FO/^FT origins, ^A0/^CF text, ^GB
 * boxes and ^BC (Code128) — and throws on a barcode/graphic command it cannot
 * draw. Returns the barcode values it drew, for the equivalence check.
 */
async function drawBlock(doc: PDFDocument, font: PDFFont, raw: string): Promise<{ page: PDFPage; barcodes: string[] }> {
  let widthDots = 800;
  let heightDots = 1200;
  const sizeMatch = { pw: /\^PW(\d+)/.exec(raw), ll: /\^LL(\d+)/.exec(raw) };
  if (sizeMatch.pw) widthDots = Number(sizeMatch.pw[1]);
  if (sizeMatch.ll) heightDots = Number(sizeMatch.ll[1]);
  const pageWidth = widthDots * DOT_TO_PT;
  const pageHeight = heightDots * DOT_TO_PT;
  const page = doc.addPage([pageWidth, pageHeight]);

  const state: DrawState = { x: 0, y: 0, fontDots: 30, barcode: null };
  const barcodes: string[] = [];
  const toPt = (dots: number) => dots * DOT_TO_PT;

  for (const token of raw.split("^")) {
    if (!token) continue;
    const code = token.slice(0, 2);
    const params = token.slice(2);
    switch (code) {
      case "XA": case "XZ": case "CI": case "FH": case "FR": case "PW": case "LL": case "LH":
        break;
      case "FO": case "FT": {
        const [x, y] = params.split(",");
        state.x = Number(x) || 0; state.y = Number(y) || 0;
        break;
      }
      case "A0": case "CF": {
        const parts = params.replace(/^[NRIB],?/, "").split(",");
        const height = Number(parts[0]);
        if (Number.isFinite(height) && height > 0) state.fontDots = height;
        break;
      }
      case "BY":
        break;
      case "BC": {
        const parts = params.split(",");
        const height = Number(parts[1]);
        state.barcode = { heightDots: Number.isFinite(height) && height > 0 ? height : 100 };
        break;
      }
      case "GB": {
        const [w, h, t] = params.split(",").map((value) => Number(value) || 0);
        page.drawRectangle({ x: toPt(state.x), y: pageHeight - toPt(state.y) - toPt(h), width: toPt(w), height: toPt(h), borderWidth: Math.max(1, toPt(t)), borderColor: rgb(0, 0, 0) });
        break;
      }
      case "FD": {
        const data = safe(params);
        if (state.barcode) {
          const image = await barcodePng(data);
          const heightPt = toPt(state.barcode.heightDots);
          const widthPt = (image.width / image.height) * heightPt;
          const embedded = await doc.embedPng(image.png);
          page.drawImage(embedded, { x: toPt(state.x), y: pageHeight - toPt(state.y) - heightPt, width: widthPt, height: heightPt });
          barcodes.push(data);
        } else if (data.trim()) {
          const size = state.fontDots * DOT_TO_PT;
          page.drawText(data, { x: toPt(state.x), y: pageHeight - toPt(state.y) - size * 0.82, size, font, color: rgb(0, 0, 0) });
        }
        break;
      }
      case "FS":
        state.barcode = null;
        break;
      default:
        if (isUnsupportedDrawCommand(code)) {
          throw new ZplError("zpl_render_unavailable", `Comando ZPL não suportado nesta versão: ^${code}. Esta versão cobre o Full do Mercado Livre (texto, caixas e Code128).`);
        }
    }
  }
  return { page, barcodes };
}

/** Renders a one-page PDF at 203 then 300 dpi and confirms each expected barcode
 * decodes somewhere on the label — the same codes-equivalent guarantee as the
 * core engine, applied to the ZPL output. */
async function barcodesSurvive(pageBytes: Uint8Array, expected: readonly string[]): Promise<boolean> {
  if (expected.length === 0) return true;
  const renderer = await openPdfRenderer(pageBytes);
  try {
    for (const dpi of [203, 300]) {
      const bitmap = await renderer.render(1, dpi, 0, {});
      const region = { x: 0, y: 0, width: bitmap.width, height: bitmap.height };
      let decoded: string;
      try {
        decoded = decodeCode(bitmap, region, "CODE_128");
      } catch {
        continue;
      }
      if (expected.includes(decoded)) return true;
    }
    return false;
  } finally {
    await renderer.close();
  }
}

export type FullMlBatchOptions = { numbering?: LabelNumbering; maxLabels?: number };

/**
 * Converts a Mercado Livre Full ZPL (`.zpl`/`.txt`/colado) into one print-ready
 * PDF: each ^XA…^XZ block becomes a 10×15 page (text + Code128), redrawn as a
 * vector PDF (pdf-lib text, bwip-js barcode) — never sent to any external
 * service. Each label's barcode is decoded at 203/300 dpi and compared to its
 * ^FD before it is admitted; a label that fails is recorded and skipped.
 */
export async function convertFullMlBatch(zpl: string, options: FullMlBatchOptions = {}): Promise<MarketplaceBatchResult> {
  const maxLabels = options.maxLabels ?? DEFAULT_MAX_LABELS;
  const document = preprocessZpl(zpl);
  const expanded: ZplBlock["raw"][] = [];
  for (const block of document.blocks) for (let copy = 0; copy < block.copies; copy += 1) expanded.push(block.raw);
  if (expanded.length > maxLabels) throw new ZplError("zpl_too_many_blocks", `O arquivo tem ${expanded.length} etiquetas; o limite é ${maxLabels}.`);

  const admitted: Uint8Array[] = [];
  const outcomes: OrderOutcome[] = [];
  for (let index = 0; index < expanded.length; index += 1) {
    try {
      const single = await PDFDocument.create();
      const font = await single.embedFont(StandardFonts.Helvetica);
      const { barcodes } = await drawBlock(single, font, expanded[index]);
      const bytes = await single.save({ useObjectStreams: true });
      if (!(await barcodesSurvive(bytes, barcodes))) {
        outcomes.push({ index, ok: false, errorCode: "barcode_unreadable", errorMessage: "O código de barras renderizado não pôde ser lido." });
        continue;
      }
      admitted.push(bytes);
      outcomes.push({ index, ok: true });
    } catch (error) {
      const code = error instanceof ZplError ? error.code : "render_failed";
      outcomes.push({ index, ok: false, errorCode: code, errorMessage: error instanceof Error ? error.message : "Falha ao renderizar a etiqueta." });
    }
  }
  if (admitted.length === 0) throw new ZplError("zpl_empty", "Nenhuma etiqueta pôde ser renderizada.");

  const numbering = options.numbering;
  const parts: Uint8Array[] = [];
  for (let position = 0; position < admitted.length; position += 1) {
    let part = admitted[position];
    if (numbering) {
      const value = numbering.start + position;
      const prefix = numbering.letter ?? "";
      part = await stampTopLeftNumber(part, numbering.showTotal ? `${prefix}${value}/${admitted.length}` : `${prefix}${value}`);
    }
    parts.push(part);
  }

  return {
    marketplace: "mercado-livre",
    bytes: await concatPdfs(parts),
    orderCount: expanded.length,
    succeeded: admitted.length,
    failed: expanded.length - admitted.length,
    outcomes,
  };
}
