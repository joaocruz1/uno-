import { createRequire } from "node:module";
import type * as ZXingTypes from "@zxing/library";

import type { RenderedBitmap } from "./render";

const require = createRequire(import.meta.url);
const {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  GlobalHistogramBinarizer,
  HybridBinarizer,
  MultiFormatReader,
  RGBLuminanceSource,
} = require("@zxing/library") as typeof ZXingTypes;

export type PixelRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SupportedCodeFormat = "CODE_128" | "QR_CODE";

export class CodeDecodeError extends Error {
  readonly code = "codes_unreadable";

  constructor(message = "Não foi possível ler o código na região informada.") {
    super(message);
    this.name = "CodeDecodeError";
  }
}

function assertBitmap(bitmap: Pick<RenderedBitmap, "width" | "height" | "rgba">) {
  if (!Number.isSafeInteger(bitmap.width) || !Number.isSafeInteger(bitmap.height) || bitmap.width < 1 || bitmap.height < 1) {
    throw new CodeDecodeError("A imagem fornecida é inválida.");
  }
  if (!(bitmap.rgba instanceof Uint8ClampedArray) || bitmap.rgba.length !== bitmap.width * bitmap.height * 4) {
    throw new CodeDecodeError("Os pixels fornecidos são inválidos.");
  }
}

function assertRegion(bitmap: Pick<RenderedBitmap, "width" | "height">, region: PixelRegion) {
  const coordinates = [region.x, region.y, region.width, region.height];
  if (!coordinates.every(Number.isSafeInteger) || region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1) {
    throw new CodeDecodeError("A região informada é inválida.");
  }
  if (region.x + region.width > bitmap.width || region.y + region.height > bitmap.height) {
    throw new CodeDecodeError("A região informada excede os limites da imagem.");
  }
}

function regionLuminance(bitmap: Pick<RenderedBitmap, "width" | "height" | "rgba">, region: PixelRegion) {
  const luminance = new Uint8ClampedArray(region.width * region.height);
  let target = 0;
  for (let row = 0; row < region.height; row += 1) {
    let source = ((region.y + row) * bitmap.width + region.x) * 4;
    for (let column = 0; column < region.width; column += 1) {
      const red = bitmap.rgba[source];
      const green = bitmap.rgba[source + 1];
      const blue = bitmap.rgba[source + 2];
      const alpha = bitmap.rgba[source + 3];
      const transparency = 255 - alpha;
      const compositeRed = (red * alpha + 255 * transparency) / 255;
      const compositeGreen = (green * alpha + 255 * transparency) / 255;
      const compositeBlue = (blue * alpha + 255 * transparency) / 255;
      luminance[target] = Math.round((compositeRed + 2 * compositeGreen + compositeBlue) / 4);
      source += 4;
      target += 1;
    }
  }
  return luminance;
}

function decodeWithoutLibraryWarnings(reader: ZXingTypes.MultiFormatReader, bitmap: ZXingTypes.BinaryBitmap) {
  // @zxing/library 0.23 writes decoder exceptions to stderr before throwing.
  // Decoding is synchronous, so this narrow guard prevents document-derived
  // diagnostics from escaping while always restoring the process console.
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    return reader.decodeWithState(bitmap);
  } finally {
    console.warn = warn;
  }
}

/** Pastes the region on a white canvas: a code cropped flush to its modules has no quiet zone to be found by. */
function withQuietZone(luminance: Uint8ClampedArray, width: number, height: number, margin: number) {
  const paddedWidth = width + margin * 2;
  const paddedHeight = height + margin * 2;
  const padded = new Uint8ClampedArray(paddedWidth * paddedHeight).fill(255);
  for (let row = 0; row < height; row += 1) {
    padded.set(luminance.subarray(row * width, (row + 1) * width), (row + margin) * paddedWidth + margin);
  }
  return { luminance: padded, width: paddedWidth, height: paddedHeight };
}

function decodeAttempt(
  luminance: Uint8ClampedArray,
  width: number,
  height: number,
  barcodeFormat: ZXingTypes.BarcodeFormat,
  binarizer: "hybrid" | "global",
  pure: boolean,
): string | null {
  const hints = new Map<ZXingTypes.DecodeHintType, unknown>([
    [DecodeHintType.TRY_HARDER, true],
    [DecodeHintType.POSSIBLE_FORMATS, [barcodeFormat]],
  ]);
  if (pure) hints.set(DecodeHintType.PURE_BARCODE, true);
  const source = new RGBLuminanceSource(luminance, width, height);
  const binaryBitmap = new BinaryBitmap(binarizer === "hybrid" ? new HybridBinarizer(source) : new GlobalHistogramBinarizer(source));
  const reader = new MultiFormatReader();
  reader.setHints(hints);
  try {
    const result = decodeWithoutLibraryWarnings(reader, binaryBitmap);
    return result.getBarcodeFormat() === barcodeFormat ? result.getText() : null;
  } catch {
    return null;
  } finally {
    reader.reset();
  }
}

/**
 * Reads one code. Marketplaces embed QR images cropped flush to the modules
 * (no quiet zone), and the reader then misses the finder patterns depending on
 * rounding at each DPI. The same pixels are retried on a white margin and with
 * a second binarizer; only the decoded text matters, and the validator still
 * requires the input and output texts to be identical.
 */
export function decodeCode(
  bitmap: Pick<RenderedBitmap, "width" | "height" | "rgba">,
  region: PixelRegion,
  format: SupportedCodeFormat,
): string {
  assertBitmap(bitmap);
  assertRegion(bitmap, region);
  const barcodeFormat = format === "CODE_128" ? BarcodeFormat.CODE_128 : BarcodeFormat.QR_CODE;
  const luminance = regionLuminance(bitmap, region);
  const margin = Math.max(8, Math.round(Math.max(region.width, region.height) * 0.1));
  const padded = withQuietZone(luminance, region.width, region.height, margin);
  const attempts = [
    () => decodeAttempt(luminance, region.width, region.height, barcodeFormat, "hybrid", false),
    () => decodeAttempt(padded.luminance, padded.width, padded.height, barcodeFormat, "hybrid", false),
    () => decodeAttempt(padded.luminance, padded.width, padded.height, barcodeFormat, "global", false),
    ...(format === "QR_CODE"
      ? [() => decodeAttempt(padded.luminance, padded.width, padded.height, barcodeFormat, "hybrid", true)]
      : []),
  ];
  for (const attempt of attempts) {
    const text = attempt();
    if (text !== null) return text;
  }
  throw new CodeDecodeError();
}
