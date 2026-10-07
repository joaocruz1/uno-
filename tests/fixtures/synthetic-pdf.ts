import bwipjs from "bwip-js/node";
import {
  closePath,
  degrees,
  lineTo,
  moveTo,
  PDFDocument,
  PDFOperator,
  PDFOperatorNames,
  StandardFonts,
  type PDFImage,
  type PDFPage,
  rgb,
} from "pdf-lib";
import QRCode from "qrcode";

import { openPdfRenderer } from "@/engine/render";

const WIDTH = 283.4646;
const HEIGHT = 425.1969;

export const SYNTHETIC_CODES = {
  logisticsBarcode: "SYNTH-001",
  logisticsQr: "https://example.invalid/synthetic/uno/001",
  danfeBarcode: "35100100000000000000",
  /** Synthetic 44-digit access key: series 001, number 000000123. */
  danfeAccessKey: "35261000000000000000550010000001231000000000",
} as const;

export type SyntheticPdfOptions = {
  reverse?: boolean;
  rotations?: readonly [0 | 90 | 180 | 270, 0 | 90 | 180 | 270];
  ambiguous?: boolean;
  unknown?: boolean;
  additionalInformation?: boolean;
  scanned?: boolean;
  /** Prints the simplified DANFE header fields and a 44-digit key barcode. */
  fiscalSummary?: boolean;
};

function yFromTop(top: number, fontSize: number): number {
  return HEIGHT - top - fontSize;
}

function drawText(page: PDFPage, text: string, top: number, size: number, font: Awaited<ReturnType<PDFDocument["embedFont"]>>, x = 9) {
  page.drawText(text, { x, y: yFromTop(top, size), size, font, color: rgb(0.05, 0.05, 0.05) });
}

function drawStructuralOuterFrame(page: PDFPage) {
  const outer = { left: 8.5039, bottom: 2.8346, right: 264.1889, top: 424.3464 };
  const inner = { left: 8.7874, bottom: 3.1181, right: 263.9055, top: 424.063 };
  page.pushOperators(
    moveTo(outer.left, outer.bottom),
    lineTo(outer.right, outer.bottom),
    lineTo(outer.right, outer.top),
    lineTo(outer.left, outer.top),
    closePath(),
    moveTo(inner.left, inner.bottom),
    lineTo(inner.right, inner.bottom),
    lineTo(inner.right, inner.top),
    lineTo(inner.left, inner.top),
    closePath(),
    PDFOperator.of(PDFOperatorNames.FillEvenOdd),
  );
}

async function barcode(document: PDFDocument, text: string, width: number, paddingwidth = 16): Promise<PDFImage> {
  const png = await bwipjs.toBuffer({
    bcid: "code128",
    text,
    scale: 4,
    height: 14,
    width,
    includetext: false,
    paddingwidth,
    paddingheight: 8,
    backgroundcolor: "FFFFFF",
  });
  return document.embedPng(png);
}

async function codeImages(document: PDFDocument, fiscalSummary = false) {
  const [logistics, danfe, qr] = await Promise.all([
    barcode(document, SYNTHETIC_CODES.logisticsBarcode, 60),
    fiscalSummary ? barcode(document, SYNTHETIC_CODES.danfeAccessKey, 80, 3) : barcode(document, SYNTHETIC_CODES.danfeBarcode, 80),
    QRCode.toBuffer(SYNTHETIC_CODES.logisticsQr, { type: "png", width: 400, margin: 4, errorCorrectionLevel: "M" })
      .then((bytes) => document.embedPng(bytes)),
  ]);
  return { logistics, danfe, qr };
}

async function drawLogistics(document: PDFDocument, page: PDFPage, options: SyntheticPdfOptions) {
  drawStructuralOuterFrame(page);
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const images = await codeImages(document);
  const primary = options.unknown ? "DOCUMENTO SINTETICO" : "DESPACHAR";
  drawText(page, options.unknown ? "CABECALHO TESTE" : "MLB 00000001", 18, 8, regular);
  drawText(page, primary, 72, 9, bold, 178);
  page.drawImage(images.logistics, { x: 37.1339, y: 270.9921, width: 170.0787, height: 56.6929 });
  drawText(page, "DESTINATARIO TESTE SINTETICO", 212, 8, regular);
  drawText(page, "RUA EXEMPLO, 100 - SEM DADOS REAIS", 263, 7, regular);
  drawText(page, "PEDIDO SINTETICO 0001", 315, 7, regular);
  page.drawImage(images.qr, { x: 167.5276, y: 29.4803, width: 85.0394, height: 85.0394 });
  if (options.ambiguous) {
    drawText(page, "CHAVE DE ACESSO", 8, 6, regular, 120);
    drawText(page, "REMETENTE TESTE", 132, 6, regular, 9);
    drawText(page, "DESTINATARIO TESTE", 160, 6, regular, 9);
    drawText(page, "DANFE", 180, 6, regular, 9);
  }
  for (const top of [4, 56, 66, 91, 94, 176, 205, 246, 255, 293, 307, 421]) {
    page.drawLine({ start: { x: 0, y: HEIGHT - top }, end: { x: WIDTH, y: HEIGHT - top }, thickness: 0.25 });
  }
}

async function drawDanfe(document: PDFDocument, page: PDFPage, options: SyntheticPdfOptions) {
  drawStructuralOuterFrame(page);
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const images = await codeImages(document, options.fiscalSummary);
  const title = options.unknown ? "DOCUMENTO FISCAL SINTETICO" : "DANFE";
  const key = options.unknown ? "REFERENCIA NUMERICA" : "CHAVE DE ACESSO";
  drawText(page, key, 8, 7, regular, options.fiscalSummary ? 141 : 9);
  if (options.fiscalSummary) {
    drawText(page, "1 - Saida", 10, 5, regular, 20);
    drawText(page, "Numero", 17, 5, regular, 20);
    drawText(page, "123/Serie 1", 17, 5, regular, 43);
    drawText(page, "Emissao", 24, 5, regular, 20);
    drawText(page, "06/10/2026", 24, 5, regular, 43);
    drawText(page, SYNTHETIC_CODES.danfeAccessKey, 18, 5, regular, 111);
  }
  page.drawImage(images.danfe, { x: 20.126, y: 312.0384, width: 226.7717, height: 56.6929 });
  drawText(page, "REMETENTE DE TESTE - CNPJ 00.000.000/0000-00", 132, 6.5, regular);
  drawText(page, "DESTINATARIO TESTE SINTETICO", 160, 6.5, regular);
  drawText(page, title, 180, 10, bold, 190);
  drawText(page, "INFORMACOES ADICIONAIS PREENCHIDAS", 331, 5.669, regular);
  if (options.additionalInformation) {
    drawText(page, "OBSERVACAO FISCAL SINTETICA PRESERVADA INTEGRALMENTE", 235, 6.5, regular);
    drawText(page, "LINHA COMPLEMENTAR SEM DADOS DE PESSOA REAL", 250, 6.5, regular);
  }
  if (options.ambiguous) {
    drawText(page, "MLB 00000002", 18, 6, regular, 9);
    drawText(page, "DESPACHAR", 72, 6, regular, 178);
  }
  for (const top of [5, 46, 53, 126, 132, 153, 161, 202, 329, 340]) {
    page.drawLine({ start: { x: 0, y: HEIGHT - top }, end: { x: WIDTH, y: HEIGHT - top }, thickness: 0.25 });
  }
}

async function digitalFixture(options: SyntheticPdfOptions): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const roles = options.reverse ? ["danfe", "logistics"] as const : ["logistics", "danfe"] as const;
  for (const [index, role] of roles.entries()) {
    const page = document.addPage([WIDTH, HEIGHT]);
    if (role === "logistics") await drawLogistics(document, page, options);
    else await drawDanfe(document, page, options);
    const rotation = options.rotations?.[index] ?? 0;
    if (rotation) page.setRotation(degrees(rotation));
  }
  return document.save({ useObjectStreams: true });
}

async function scannedFixture(bytes: Uint8Array, rotations: SyntheticPdfOptions["rotations"]): Promise<Uint8Array> {
  const renderer = await openPdfRenderer(bytes);
  const output = await PDFDocument.create();
  try {
    for (let pageNumber = 1; pageNumber <= 2; pageNumber += 1) {
      const bitmap = await renderer.render(pageNumber, 300, 0);
      const image = await output.embedPng(bitmap.png);
      const page = output.addPage([WIDTH, HEIGHT]);
      page.drawImage(image, { x: 0, y: 0, width: WIDTH, height: HEIGHT });
      const rotation = rotations?.[pageNumber - 1] ?? 0;
      if (rotation) page.setRotation(degrees(rotation));
    }
  } finally {
    await renderer.close();
  }
  return output.save({ useObjectStreams: true });
}

export async function syntheticPdf(options: SyntheticPdfOptions = {}): Promise<Uint8Array> {
  const digital = await digitalFixture({ ...options, rotations: options.scanned ? undefined : options.rotations });
  return options.scanned ? scannedFixture(digital, options.rotations) : digital;
}

export async function syntheticPdfWithJavaScript(): Promise<Uint8Array> {
  const document = await PDFDocument.load(await syntheticPdf());
  document.addJavaScript("synthetic-action", "void(0)");
  return document.save();
}
