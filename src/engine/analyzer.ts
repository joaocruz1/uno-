import { PDFDict, PDFDocument, PDFName } from "pdf-lib";

import { EngineError } from "./errors";
import { DIMENSION_TOLERANCE_PT, isTemplateOuterFrame, PAGE_HEIGHT_PT, PAGE_WIDTH_PT } from "./template";
import type { Analysis, AnalyzedPage, Analyzer, PdfRect, TextEvidence } from "./types";

type PdfTextItem = { str: string; width: number; height: number; transform: number[] };
type Matrix = [number, number, number, number, number, number];
const ANALYSIS_TIMEOUT_MS = 15_000;

function isTextItem(value: unknown): value is PdfTextItem {
  const item = value as Partial<PdfTextItem>;
  return typeof item?.str === "string" && typeof item.width === "number" &&
    typeof item.height === "number" && Array.isArray(item.transform);
}

function textBox(item: PdfTextItem): PdfRect {
  const x = item.transform[4] ?? 0;
  const baseline = item.transform[5] ?? 0;
  const height = Math.max(Math.abs(item.height), Math.abs(item.transform[3] ?? 0), 1);
  return { left: x, bottom: baseline - height * 0.25, right: x + Math.max(item.width, 1), top: baseline + height };
}

function supportedDimensions(width: number, height: number): boolean {
  return Math.abs(width - PAGE_WIDTH_PT) <= DIMENSION_TOLERANCE_PT &&
    Math.abs(height - PAGE_HEIGHT_PT) <= DIMENSION_TOLERANCE_PT;
}

function multiply(first: Matrix, second: Matrix): Matrix {
  return [
    first[0] * second[0] + first[2] * second[1],
    first[1] * second[0] + first[3] * second[1],
    first[0] * second[2] + first[2] * second[3],
    first[1] * second[2] + first[3] * second[3],
    first[0] * second[4] + first[2] * second[5] + first[4],
    first[1] * second[4] + first[3] * second[5] + first[5],
  ];
}

function point(matrix: Matrix, x: number, y: number): readonly [number, number] {
  return [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
}

function imageBoxes(operatorList: { fnArray: number[]; argsArray: unknown[][] }, ops: Record<string, number>): PdfRect[] {
  let current: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  const formStack: Matrix[] = [];
  const imageOps = new Set([
    ops.paintImageXObject,
    ops.paintInlineImageXObject,
    ops.paintImageMaskXObject,
    ops.paintSolidColorImageMask,
  ]);
  const boxes: PdfRect[] = [];
  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const operation = operatorList.fnArray[index];
    if (operation === ops.paintFormXObjectBegin) {
      const matrix = operatorList.argsArray[index]?.[0];
      formStack.push([...current]);
      if (matrix !== null && matrix !== undefined) {
        if (!(matrix instanceof Float32Array) || matrix.length !== 6 || ![...matrix].every(Number.isFinite)) {
          throw new EngineError("invalid_pdf");
        }
        current = multiply(current, [...matrix] as Matrix);
      }
    } else if (operation === ops.paintFormXObjectEnd) {
      current = formStack.pop() ?? current;
    } else if (operation === ops.save) stack.push([...current]);
    else if (operation === ops.restore) current = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (operation === ops.transform) {
      const args = operatorList.argsArray[index];
      if (args.length >= 6 && args.slice(0, 6).every((value) => typeof value === "number")) {
        current = multiply(current, args.slice(0, 6) as Matrix);
      }
    } else if (imageOps.has(operation)) {
      const corners = [point(current, 0, 0), point(current, 1, 0), point(current, 0, 1), point(current, 1, 1)];
      const xs = corners.map(([x]) => x);
      const ys = corners.map(([, y]) => y);
      const box = { left: Math.min(...xs), bottom: Math.min(...ys), right: Math.max(...xs), top: Math.max(...ys) };
      if ((box.right - box.left) * (box.top - box.bottom) >= 25) boxes.push(box);
    }
  }
  return boxes;
}

function union(first: PdfRect | undefined, second: PdfRect): PdfRect {
  if (!first) return second;
  return {
    left: Math.min(first.left, second.left),
    bottom: Math.min(first.bottom, second.bottom),
    right: Math.max(first.right, second.right),
    top: Math.max(first.top, second.top),
  };
}

function knownStructuralOuterFrame(
  argumentsForPath: unknown[],
  transformed: PdfRect,
  current: Matrix,
  bundledPaintOperation: unknown,
  ops: Record<string, number>,
): boolean {
  if (bundledPaintOperation !== ops.eoFill || !isTemplateOuterFrame(transformed)) return false;
  const pathData = argumentsForPath[1];
  if (!Array.isArray(pathData) || pathData.length !== 1 || !(pathData[0] instanceof Float32Array) || pathData[0].length !== 26) {
    return false;
  }
  const values = pathData[0];
  const expectedCommands = [[0, 0], [3, 1], [6, 1], [9, 1], [12, 4], [13, 0], [16, 1], [19, 1], [22, 1], [25, 4]] as const;
  if (expectedCommands.some(([index, command]) => values[index] !== command)) return false;
  const innerCorners = [
    point(current, values[14], values[15]),
    point(current, values[17], values[18]),
    point(current, values[20], values[21]),
    point(current, values[23], values[24]),
  ];
  const xs = innerCorners.map(([x]) => x);
  const ys = innerCorners.map(([, y]) => y);
  const inner = { left: Math.min(...xs), bottom: Math.min(...ys), right: Math.max(...xs), top: Math.max(...ys) };
  return inner.left > transformed.left && inner.bottom > transformed.bottom &&
    inner.right < transformed.right && inner.top < transformed.top &&
    inner.left - transformed.left <= 0.75 && inner.bottom - transformed.bottom <= 0.75 &&
    transformed.right - inner.right <= 0.75 && transformed.top - inner.top <= 0.75;
}

function paintedPathBoxes(operatorList: { fnArray: number[]; argsArray: unknown[][] }, ops: Record<string, number>): PdfRect[] {
  const boxes: PdfRect[] = [];
  let current: Matrix = [1, 0, 0, 1, 0, 0];
  let lineWidth = 1;
  const stack: Array<{ matrix: Matrix; lineWidth: number }> = [];
  const formStack: Array<{ matrix: Matrix; lineWidth: number }> = [];
  let pending: PdfRect | undefined;
  const fillOperations = new Set([ops.fill, ops.eoFill]);
  const strokeOperations = new Set([ops.stroke, ops.closeStroke]);
  const fillStrokeOperations = new Set([
    ops.fillStroke,
    ops.eoFillStroke,
    ops.closeFillStroke,
    ops.closeEOFillStroke,
  ]);
  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const operation = operatorList.fnArray[index];
    if (operation === ops.paintFormXObjectBegin) {
      const matrix = operatorList.argsArray[index]?.[0];
      formStack.push({ matrix: [...current], lineWidth });
      if (matrix !== null && matrix !== undefined) {
        if (!(matrix instanceof Float32Array) || matrix.length !== 6 || ![...matrix].every(Number.isFinite)) {
          throw new EngineError("invalid_pdf");
        }
        current = multiply(current, [...matrix] as Matrix);
      }
    } else if (operation === ops.paintFormXObjectEnd) {
      const restored = formStack.pop();
      current = restored?.matrix ?? current;
      lineWidth = restored?.lineWidth ?? lineWidth;
      pending = undefined;
    } else if (operation === ops.save) stack.push({ matrix: [...current], lineWidth });
    else if (operation === ops.restore) {
      const restored = stack.pop();
      current = restored?.matrix ?? [1, 0, 0, 1, 0, 0];
      lineWidth = restored?.lineWidth ?? 1;
    } else if (operation === ops.transform) {
      const args = operatorList.argsArray[index];
      if (args.length >= 6 && args.slice(0, 6).every((value) => typeof value === "number")) {
        current = multiply(current, args.slice(0, 6) as Matrix);
      }
    } else if (operation === ops.setLineWidth) {
      const width = operatorList.argsArray[index]?.[0];
      if (typeof width === "number" && Number.isFinite(width) && width >= 0) lineWidth = width;
    } else if (operation === ops.constructPath) {
      const argumentsForPath = operatorList.argsArray[index];
      const minMax = argumentsForPath?.[2];
      if (!(minMax instanceof Float32Array) || minMax.length !== 4 || ![...minMax].every(Number.isFinite)) continue;
      const [left, bottom, right, top] = minMax;
      const corners = [point(current, left, bottom), point(current, right, bottom), point(current, left, top), point(current, right, top)];
      const xs = corners.map(([x]) => x);
      const ys = corners.map(([, y]) => y);
      const transformed = { left: Math.min(...xs), bottom: Math.min(...ys), right: Math.max(...xs), top: Math.max(...ys) };
      const bundledPaintOperation = argumentsForPath?.[0];
      if (knownStructuralOuterFrame(argumentsForPath, transformed, current, bundledPaintOperation, ops)) continue;
      if (typeof bundledPaintOperation === "number" &&
        (fillOperations.has(bundledPaintOperation) || strokeOperations.has(bundledPaintOperation) ||
          fillStrokeOperations.has(bundledPaintOperation))) {
        if (strokeOperations.has(bundledPaintOperation) || fillStrokeOperations.has(bundledPaintOperation)) {
          const scale = Math.max(Math.hypot(current[0], current[1]), Math.hypot(current[2], current[3]));
          const extent = lineWidth * scale / 2;
          boxes.push({ left: transformed.left - extent, bottom: transformed.bottom - extent, right: transformed.right + extent, top: transformed.top + extent });
        } else {
          boxes.push(transformed);
        }
      } else {
        pending = union(pending, transformed);
      }
    } else if (pending && (fillOperations.has(operation) || strokeOperations.has(operation) || fillStrokeOperations.has(operation))) {
      if (strokeOperations.has(operation) || fillStrokeOperations.has(operation)) {
        const scale = Math.max(Math.hypot(current[0], current[1]), Math.hypot(current[2], current[3]));
        const extent = lineWidth * scale / 2;
        boxes.push({ left: pending.left - extent, bottom: pending.bottom - extent, right: pending.right + extent, top: pending.top + extent });
      } else {
        boxes.push(pending);
      }
      pending = undefined;
    } else if (operation === ops.endPath) {
      pending = undefined;
    }
  }
  return boxes;
}

async function assertNoUnsafeObjects(bytes: Uint8Array): Promise<void> {
  let document: PDFDocument;
  try {
    document = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch {
    return;
  }
  const names = PDFName.of("Names");
  const javaScript = PDFName.of("JavaScript");
  const js = PDFName.of("JS");
  const subtype = PDFName.of("Subtype");
  const embeddedFile = PDFName.of("EmbeddedFile");
  const openAction = PDFName.of("OpenAction");
  if (document.catalog.has(openAction)) throw new EngineError("invalid_pdf");
  const nameDictionary = document.catalog.get(names);
  if (nameDictionary instanceof PDFDict && (nameDictionary.has(javaScript) || nameDictionary.has(PDFName.of("EmbeddedFiles")))) {
    throw new EngineError("invalid_pdf");
  }
  for (const [, object] of document.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) continue;
    if (object.has(js) || object.get(PDFName.of("S"))?.toString() === javaScript.toString() ||
      object.get(subtype)?.toString() === embeddedFile.toString()) {
      throw new EngineError("invalid_pdf");
    }
  }
}

async function beforeDeadline<T>(promise: Promise<T>, deadline: number, cancel: () => void): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    cancel();
    throw new EngineError("invalid_pdf");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          cancel();
          reject(new EngineError("invalid_pdf"));
        }, remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class PdfAnalyzer implements Analyzer {
  async analyze(bytes: Uint8Array): Promise<Analysis> {
    if (bytes.length < 8 || bytes.length > 104_857_600) throw new EngineError("invalid_pdf");
    await assertNoUnsafeObjects(bytes);
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const deadline = Date.now() + ANALYSIS_TIMEOUT_MS;
    const documentOptions = {
      data: bytes.slice(),
      isEvalSupported: false,
      useSystemFonts: true,
      stopAtErrors: true,
      enableXfa: false,
      maxImageSize: 15_000_000,
      isImageDecoderSupported: false,
      isOffscreenCanvasSupported: false,
    };
    const loadingTask = pdfjs.getDocument(documentOptions);
    const limited = <T>(promise: Promise<T>) => beforeDeadline(promise, deadline, () => { void loadingTask.destroy(); });
    try {
      const document = await limited(loadingTask.promise);
      if (document.numPages !== 2) throw new EngineError("invalid_page_count");
      const actions = await limited(document.getJSActions());
      if (actions && Object.keys(actions).length > 0) throw new EngineError("invalid_pdf");
      const attachments = await limited(document.getAttachments());
      if (attachments && Object.keys(attachments).length > 0) throw new EngineError("invalid_pdf");

      const pages: AnalyzedPage[] = [];
      for (let pageNumber = 1; pageNumber <= 2; pageNumber += 1) {
        const page = await limited(document.getPage(pageNumber));
        const pageActions = await limited(page.getJSActions());
        if (pageActions && Object.keys(pageActions).length > 0) throw new EngineError("invalid_pdf");
        const annotations = await limited(page.getAnnotations({ intent: "any" }));
        if (annotations.length > 0) throw new EngineError("invalid_pdf");
        const width = Math.abs(page.view[2] - page.view[0]);
        const height = Math.abs(page.view[3] - page.view[1]);
        const rotation = page.rotate;
        if (![0, 90, 180, 270].includes(rotation) || !supportedDimensions(width, height)) {
          throw new EngineError("invalid_pdf");
        }
        const operators = await limited(page.getOperatorList());
        if (operators.fnArray.length > 200_000) throw new EngineError("invalid_pdf");
        const textContent = await limited(page.getTextContent());
        const rawItems: unknown[] = textContent.items;
        const textItems: TextEvidence[] = rawItems
          .filter(isTextItem)
          .filter((item) => item.str.trim().length > 0)
          .map((item) => ({ text: item.str, box: textBox(item) }));
        const text = textItems.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim();
        const images = imageBoxes(operators, pdfjs.OPS as unknown as Record<string, number>);
        const paths = paintedPathBoxes(operators, pdfjs.OPS as unknown as Record<string, number>);
        pages.push({
          pageNumber,
          width,
          height,
          rotation: rotation as 0 | 90 | 180 | 270,
          kind: text.replace(/\s/g, "").length >= 10 ? "digital" : "scanned",
          text,
          textItems,
          imageBoxes: images,
          pathBoxes: paths,
        });
      }
      return { bytes, pages: pages as [AnalyzedPage, AnalyzedPage] };
    } catch (error) {
      if (error instanceof EngineError) throw error;
      const candidate = error as { name?: string; code?: number };
      if (candidate?.name === "PasswordException" || candidate?.code === 1 || candidate?.code === 2) {
        throw new EngineError("pdf_encrypted");
      }
      throw new EngineError("invalid_pdf");
    } finally {
      await loadingTask.destroy();
    }
  }
}

export const analyzePdf = (bytes: Uint8Array) => new PdfAnalyzer().analyze(bytes);
