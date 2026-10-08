import bwipjs from "bwip-js/node";
import { PDFDocument } from "pdf-lib";
import QRCode from "qrcode";
import { describe, expect, it } from "vitest";

import { CodeDecodeError, decodeCode, type PixelRegion } from "@/engine/barcodes";
import { openPdfRenderer, type RenderedBitmap } from "@/engine/render";

const CODE_128_VALUE = "SYNTHETIC-CODE-128-001";
const QR_CODE_VALUE = "SYNTHETIC-QR-001";
const POINTS_PER_INCH = 72;
const MILLIMETERS_PER_INCH = 25.4;

type PdfFixture = {
  bytes: Uint8Array;
  page: { width: number; height: number };
  code128: { x: number; y: number; width: number; height: number };
  qrCode: { x: number; y: number; width: number; height: number };
};

function mmToPoints(millimeters: number) {
  return (millimeters / MILLIMETERS_PER_INCH) * POINTS_PER_INCH;
}

async function syntheticCodecPdf(): Promise<PdfFixture> {
  const document = await PDFDocument.create();
  const pageSize = { width: mmToPoints(100), height: mmToPoints(150) };
  const page = document.addPage([pageSize.width, pageSize.height]);
  const code128 = {
    x: mmToPoints(5),
    y: mmToPoints(105),
    width: mmToPoints(90),
    height: mmToPoints(25),
  };
  const qrCode = {
    x: mmToPoints(31),
    y: mmToPoints(42),
    width: mmToPoints(38),
    height: mmToPoints(38),
  };

  const code128Png = await bwipjs.toBuffer({
    bcid: "code128",
    text: CODE_128_VALUE,
    scale: 4,
    height: 14,
    includetext: false,
    paddingwidth: 12,
    paddingheight: 8,
    backgroundcolor: "FFFFFF",
  });
  const qrCodePng = await QRCode.toBuffer(QR_CODE_VALUE, {
    type: "png",
    width: 360,
    margin: 4,
    errorCorrectionLevel: "M",
  });
  const [embeddedCode128, embeddedQrCode] = await Promise.all([
    document.embedPng(code128Png),
    document.embedPng(qrCodePng),
  ]);
  page.drawImage(embeddedCode128, code128);
  page.drawImage(embeddedQrCode, qrCode);
  return { bytes: await document.save(), page: pageSize, code128, qrCode };
}

function pixelRegion(
  bitmap: Pick<RenderedBitmap, "width" | "height">,
  page: PdfFixture["page"],
  box: PdfFixture["code128"],
): PixelRegion {
  const scaleX = bitmap.width / page.width;
  const scaleY = bitmap.height / page.height;
  const left = Math.max(0, Math.floor(box.x * scaleX) - 2);
  const top = Math.max(0, Math.floor((page.height - box.y - box.height) * scaleY) - 2);
  const right = Math.min(bitmap.width, Math.ceil((box.x + box.width) * scaleX) + 2);
  const bottom = Math.min(bitmap.height, Math.ceil((page.height - box.y) * scaleY) + 2);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

describe("PDF renderer and protected-code decoder", () => {
  it.each([203, 300])("renders and decodes synthetic CODE 128 and QR fixtures at %i dpi", async (dpi) => {
    const fixture = await syntheticCodecPdf();
    const renderer = await openPdfRenderer(fixture.bytes);
    try {
      const bitmap = await renderer.render(1, dpi, 0, { png: true });
      expect(bitmap.width).toBe(Math.ceil((100 / MILLIMETERS_PER_INCH) * dpi));
      expect(bitmap.height).toBe(Math.ceil((150 / MILLIMETERS_PER_INCH) * dpi));
      expect(bitmap.rgba).toHaveLength(bitmap.width * bitmap.height * 4);
      expect(bitmap.png?.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(decodeCode(bitmap, pixelRegion(bitmap, fixture.page, fixture.code128), "CODE_128")).toBe(CODE_128_VALUE);
      expect(decodeCode(bitmap, pixelRegion(bitmap, fixture.page, fixture.qrCode), "QR_CODE")).toBe(QR_CODE_VALUE);
    } finally {
      await renderer.close();
    }
  }, 30_000);

  it("caches the document while allowing normalized page rotations", async () => {
    const fixture = await syntheticCodecPdf();
    const renderer = await openPdfRenderer(fixture.bytes);
    try {
      const rotated = await renderer.render(1, 203, -270);
      expect(rotated.width).toBe(Math.ceil((150 / MILLIMETERS_PER_INCH) * 203));
      expect(rotated.height).toBe(Math.ceil((100 / MILLIMETERS_PER_INCH) * 203));
      const unrotated = await renderer.render(1, 203, 0);
      expect(unrotated.width).toBeLessThan(unrotated.height);
    } finally {
      await renderer.close();
    }
  }, 30_000);

  it("rejects unsafe render requests with typed, content-free errors", async () => {
    const fixture = await syntheticCodecPdf();
    const renderer = await openPdfRenderer(fixture.bytes);
    try {
      await expect(renderer.render(0, 203)).rejects.toMatchObject({ code: "invalid_page" });
      await expect(renderer.render(1, 203, 45)).rejects.toMatchObject({ code: "invalid_render_request" });
      await expect(renderer.render(1, Number.NaN)).rejects.toMatchObject({ code: "invalid_render_request" });
    } finally {
      await renderer.close();
    }
    await expect(renderer.render(1, 203)).rejects.toMatchObject({ code: "render_failed" });
  });

  it("rejects oversized pages before allocating their rendered bitmap", async () => {
    const document = await PDFDocument.create();
    document.addPage([mmToPoints(211), mmToPoints(300)]);
    const renderer = await openPdfRenderer(await document.save());
    try {
      await expect(renderer.render(1, 300)).rejects.toMatchObject({ code: "render_too_large" });
    } finally {
      await renderer.close();
    }
  });

  it("rejects unreadable pixels and regions outside the caller-provided quiet zone", () => {
    const bitmap = {
      width: 80,
      height: 80,
      rgba: new Uint8ClampedArray(80 * 80 * 4).fill(255),
    };
    expect(() => decodeCode(bitmap, { x: 0, y: 0, width: 80, height: 80 }, "QR_CODE")).toThrow(CodeDecodeError);
    expect(() => decodeCode(bitmap, { x: -1, y: 0, width: 10, height: 10 }, "CODE_128")).toThrow("A região informada é inválida.");
    expect(() => decodeCode(bitmap, { x: 70, y: 70, width: 11, height: 10 }, "QR_CODE")).toThrow("A região informada excede os limites da imagem.");
  });
});
