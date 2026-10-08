export type RenderedBitmap = {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  /** Present only when the render was requested with `{ png: true }`; encoding is costly and only OCR needs it. */
  png?: Buffer;
};

export type RenderOptions = {
  /** Also encode the bitmap as PNG. Off by default: barcode and pixel checks read `rgba` directly. */
  png?: boolean;
};

export type PdfRenderer = {
  render(pageNumber: number, dpi: number, rotation?: number, options?: RenderOptions): Promise<RenderedBitmap>;
  close(): Promise<void>;
};

export class PdfRenderError extends Error {
  constructor(
    public readonly code: "invalid_pdf" | "invalid_page" | "invalid_render_request" | "render_too_large" | "render_failed",
    message: string,
  ) {
    super(message);
    this.name = "PdfRenderError";
  }
}

const POINTS_PER_INCH = 72;
const MILLIMETERS_PER_INCH = 25.4;
const MAX_PAGE_WIDTH_MM = 210;
const MAX_PAGE_HEIGHT_MM = 300;
const MAX_RENDER_PIXELS = 15_000_000;

function normalizeRotation(rotation: number): 0 | 90 | 180 | 270 {
  if (!Number.isInteger(rotation) || rotation % 90 !== 0) {
    throw new PdfRenderError("invalid_render_request", "A rotação deve ser um múltiplo de 90 graus.");
  }
  const normalized = ((rotation % 360) + 360) % 360;
  return normalized as 0 | 90 | 180 | 270;
}

function checkedDimension(value: number) {
  const rounded = Math.ceil(value);
  if (!Number.isSafeInteger(rounded) || rounded < 1) {
    throw new PdfRenderError("invalid_render_request", "As dimensões de renderização são inválidas.");
  }
  return rounded;
}

function assertPageBounds(widthPoints: number, heightPoints: number) {
  const widthMm = (widthPoints / POINTS_PER_INCH) * MILLIMETERS_PER_INCH;
  const heightMm = (heightPoints / POINTS_PER_INCH) * MILLIMETERS_PER_INCH;
  const toleranceMm = 0.1;
  if (widthMm > MAX_PAGE_WIDTH_MM + toleranceMm || heightMm > MAX_PAGE_HEIGHT_MM + toleranceMm) {
    throw new PdfRenderError("render_too_large", "A página excede as dimensões máximas de renderização.");
  }
}

/**
 * Opens one cached PDF.js loading task. Callers must close the renderer in a
 * finally block so the document worker and native resources are released.
 */
export async function openPdfRenderer(bytes: Uint8Array): Promise<PdfRenderer> {
  if (typeof window !== "undefined") {
    throw new PdfRenderError("invalid_render_request", "A renderização de PDF está disponível apenas no servidor.");
  }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1) {
    throw new PdfRenderError("invalid_pdf", "O documento PDF é inválido.");
  }

  const canvasModule = await import("@napi-rs/canvas");
  Object.assign(globalThis, {
    DOMMatrix: canvasModule.DOMMatrix,
    ImageData: canvasModule.ImageData,
    Path2D: canvasModule.Path2D,
  });
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  class NativeCanvasFactory {
    create(width: number, height: number) {
      const canvas = canvasModule.createCanvas(checkedDimension(width), checkedDimension(height));
      return { canvas, context: canvas.getContext("2d") };
    }

    reset(target: ReturnType<NativeCanvasFactory["create"]>, width: number, height: number) {
      target.canvas.width = checkedDimension(width);
      target.canvas.height = checkedDimension(height);
    }

    destroy(target: ReturnType<NativeCanvasFactory["create"]>) {
      target.canvas.width = 0;
      target.canvas.height = 0;
    }
  }

  const documentOptions = {
    data: Uint8Array.from(bytes),
    isEvalSupported: false,
    enableXfa: false,
    stopAtErrors: true,
    maxImageSize: MAX_RENDER_PIXELS,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    CanvasFactory: NativeCanvasFactory,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  } as Parameters<typeof pdfjs.getDocument>[0] & { isEvalSupported: false };
  const loadingTask = pdfjs.getDocument(documentOptions);

  let document: Awaited<typeof loadingTask.promise>;
  try {
    document = await loadingTask.promise;
  } catch {
    await loadingTask.destroy().catch(() => undefined);
    throw new PdfRenderError("invalid_pdf", "O documento PDF não pôde ser aberto.");
  }

  let closed = false;
  return {
    async render(pageNumber, dpi, rotation = 0, options = {}) {
      if (closed) throw new PdfRenderError("render_failed", "O renderizador já foi encerrado.");
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > document.numPages) {
        throw new PdfRenderError("invalid_page", "A página solicitada não existe.");
      }
      if (!Number.isFinite(dpi) || dpi <= 0) {
        throw new PdfRenderError("invalid_render_request", "O DPI de renderização é inválido.");
      }

      try {
        const page = await document.getPage(pageNumber);
        const normalizedRotation = normalizeRotation(rotation);
        const physicalViewport = page.getViewport({ scale: 1, rotation: normalizedRotation });
        assertPageBounds(physicalViewport.width, physicalViewport.height);

        const viewport = page.getViewport({ scale: dpi / POINTS_PER_INCH, rotation: normalizedRotation });
        const width = checkedDimension(viewport.width);
        const height = checkedDimension(viewport.height);
        if (width * height > MAX_RENDER_PIXELS) {
          throw new PdfRenderError("render_too_large", "A renderização excede o limite seguro de pixels.");
        }

        const canvas = canvasModule.createCanvas(width, height);
        const context = canvas.getContext("2d");
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
        await page.render({
          canvas: null,
          canvasContext: context as unknown as CanvasRenderingContext2D,
          viewport,
          intent: "print",
          annotationMode: pdfjs.AnnotationMode.DISABLE,
          background: "#ffffff",
        }).promise;

        const imageData = context.getImageData(0, 0, width, height);
        return {
          width,
          height,
          rgba: new Uint8ClampedArray(imageData.data),
          ...(options.png ? { png: canvas.toBuffer("image/png") } : {}),
        };
      } catch (error) {
        if (error instanceof PdfRenderError) throw error;
        throw new PdfRenderError("render_failed", "Não foi possível renderizar a página PDF.");
      }
    },

    async close() {
      if (closed) return;
      closed = true;
      try {
        await document.cleanup();
      } finally {
        await loadingTask.destroy();
      }
    },
  };
}
