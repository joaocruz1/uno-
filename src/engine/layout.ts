import { EngineError } from "./errors";
import { findTemplateDefinition } from "./templates";
import type { ConversionOptions, Extraction, ExtractedRegion, FiscalStrip, Layout, LayoutPlan, OutputSize, PageRole, PdfRect, PickingItem, PlacedRegion, ProductHeader } from "./types";

const POINTS_PER_MM = 72 / 25.4;
const MARGIN_PT = 6;
const GAP_PT = 1;

/** Compact fiscal strip metrics, in points. */
const COMPACT_MARGIN_PT = 3;
const STRIP_GAP_PT = 2;
const STRIP_SIDE_PT = 8;
const STRIP_TITLE_PT = 10;
const STRIP_LINE_PT = 9;
const STRIP_BARCODE_PT = 24;
const STRIP_DIGITS_PT = 8;
const STRIP_HEIGHT_PT = STRIP_TITLE_PT + STRIP_LINE_PT + 2 + STRIP_BARCODE_PT + STRIP_DIGITS_PT;
/** Below this the logistics codes and text are no longer trusted to print legibly. */
const MIN_COMPACT_SCALE = 0.8;
/** "SKU / Variação / Qtd" table below the fiscal strip when the caller supplies picking data. */
const TABLE_GAP_PT = 3;
const TABLE_HEADER_PT = 9;
const TABLE_ROW_PT = 10;
const MAX_ITEMS = 20;
const TRIM_PADDING_PT = 2.5;

const text = (value: unknown, max: number) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);

function isItem(value: PickingItem): boolean {
  return typeof value === "object" && value !== null && Number.isInteger(value.quantity) && value.quantity >= 1 && value.quantity <= 9_999 &&
    (value.title === undefined || text(value.title, 140)) && (value.sku === undefined || text(value.sku, 60)) &&
    (value.variation === undefined || text(value.variation, 60)) && (value.sku !== undefined || value.title !== undefined);
}

/** Both input shapes become table rows; anything malformed is refused instead of printed. */
function pickingItems(product: ProductHeader | undefined): PickingItem[] | undefined {
  if (product === undefined) return undefined;
  if (typeof product !== "object" || product === null) throw new EngineError("validation_failed");
  const items = "items" in product ? product.items : [product];
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_ITEMS || !items.every(isItem)) {
    throw new EngineError("validation_failed");
  }
  return items;
}

/** Height of a table showing `shown` rows, plus one summary row when some items are left out. */
function tableHeight(shown: number, total: number): number {
  return TABLE_GAP_PT + TABLE_HEADER_PT + (shown + (shown < total ? 1 : 0)) * TABLE_ROW_PT;
}

/** Most rows (at least one) whose table fits; undefined when not even one does. */
function fittingRows(total: number, fits: (height: number) => boolean): number | undefined {
  for (let shown = total; shown >= 1; shown -= 1) if (fits(tableHeight(shown, total))) return shown;
  return undefined;
}

function itemsTable(widthPt: number, top: number, items: PickingItem[], shown: number): NonNullable<LayoutPlan["itemsTable"]> {
  const boxTop = top - TABLE_GAP_PT;
  return {
    box: { left: STRIP_SIDE_PT, right: widthPt - STRIP_SIDE_PT, top: boxTop, bottom: top - tableHeight(shown, items.length) },
    headerHeight: TABLE_HEADER_PT,
    rowHeight: TABLE_ROW_PT,
    items: items.slice(0, shown),
    hidden: items.length - shown,
  };
}

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

function stack(regions: ExtractedRegion[], widthPt: number, top: number, scale: number): { placed: PlacedRegion[]; bottom: number } {
  let cursorTop = top;
  const placed = regions.map((region) => {
    const regionWidth = (region.box.right - region.box.left) * scale;
    const regionHeight = height(region.box) * scale;
    const left = (widthPt - regionWidth) / 2;
    const outputBox = { left, bottom: cursorTop - regionHeight, right: left + regionWidth, top: cursorTop };
    cursorTop = outputBox.bottom - GAP_PT;
    return { ...region, outputBox };
  });
  return { placed, bottom: placed.length > 0 ? placed[placed.length - 1].outputBox.bottom : top };
}

function placeCodes(extraction: Extraction, placed: PlacedRegion[], scale: number, skipId?: string) {
  return extraction.protectedCodes.filter((code) => code.id !== skipId).map((code) => {
    const container = placed.find((region) => region.pageNumber === code.pageNumber &&
      code.box.left >= region.box.left - 1 && code.box.right <= region.box.right + 1 &&
      code.box.bottom >= region.box.bottom - 1 && code.box.top <= region.box.top + 1);
    if (!container) throw new EngineError("missing_required_region");
    const outputBox = {
      left: container.outputBox.left + (code.box.left - container.box.left) * scale,
      right: container.outputBox.left + (code.box.right - container.box.left) * scale,
      bottom: container.outputBox.bottom + (code.box.bottom - container.box.bottom) * scale,
      top: container.outputBox.bottom + (code.box.top - container.box.bottom) * scale,
    };
    return { ...code, outputBox };
  });
}

/**
 * Drops blank bands above and below a region's real content so the items
 * table can share the page without shrinking the label more than necessary.
 */
function trimToContent(region: ExtractedRegion, extraction: Extraction): ExtractedRegion {
  const inside = [
    ...extraction.contentBoxes.filter((content) => content.pageNumber === region.pageNumber).map((content) => content.box),
    ...extraction.protectedCodes.filter((code) => code.pageNumber === region.pageNumber).map((code) => code.box),
  ].filter((box) => box.top > region.box.bottom && box.bottom < region.box.top);
  if (inside.length === 0) return region;
  const top = Math.min(region.box.top, Math.max(...inside.map((box) => box.top)) + TRIM_PADDING_PT);
  const bottom = Math.max(region.box.bottom, Math.min(...inside.map((box) => box.bottom)) - TRIM_PADDING_PT);
  return top - bottom < height(region.box) ? { ...region, box: { ...region.box, top, bottom } } : region;
}

export class SafeLayoutEngine implements Layout {
  async layout(extraction: Extraction, outputSize: OutputSize, options: ConversionOptions = {}): Promise<LayoutPlan> {
    const { widthMm, heightMm } = dimensions(outputSize);
    const widthPt = widthMm * POINTS_PER_MM;
    const heightPt = heightMm * POINTS_PER_MM;
    const items = pickingItems(options.product);
    const compact = this.compact(extraction, { widthMm, heightMm, widthPt, heightPt }, items);
    if (compact) return compact;

    const regions = [...extraction.regions].sort((a, b) =>
      roleOrder(a.role) - roleOrder(b.role) || b.box.top - a.box.top,
    );
    const widest = Math.max(...regions.map((region) => region.box.right - region.box.left));
    const usefulHeight = regions.reduce((total, region) => total + height(region.box), 0);
    const requiredHeight = usefulHeight + MARGIN_PT * 2 + GAP_PT * Math.max(0, regions.length - 1);
    const shown = items ? fittingRows(items.length, (table) => heightPt + 0.5 >= requiredHeight + table) : 0;
    if (widthPt + 0.5 < widest || heightPt + 0.5 < requiredHeight || shown === undefined) {
      throw new EngineError("format_too_small");
    }
    const { placed, bottom } = stack(regions, widthPt, heightPt - MARGIN_PT, 1);
    return {
      extraction, widthMm, heightMm, widthPt, heightPt, scale: 1, regions: placed, protectedCodes: placeCodes(extraction, placed, 1),
      ...(items ? { itemsTable: itemsTable(widthPt, bottom, items, shown) } : {}),
    };
  }

  /**
   * Logistics label followed by a short fiscal strip. Used whenever the fiscal
   * page could be summarized exactly; otherwise the caller keeps every region.
   */
  private compact(
    extraction: Extraction,
    page: { widthMm: number; heightMm: number; widthPt: number; heightPt: number },
    items?: PickingItem[],
  ): LayoutPlan | undefined {
    const summary = extraction.fiscalSummary;
    const definition = findTemplateDefinition(extraction.detection.templateKey, extraction.detection.templateVersion);
    const barcode = extraction.protectedCodes.find((code) => code.id === definition?.compactFiscal?.barcodeId);
    if (!summary || !barcode) return undefined;

    const regions = extraction.regions.filter((region) => region.role === "logistics").sort((a, b) => b.box.top - a.box.top)
      .map((region) => (items ? trimToContent(region, extraction) : region));
    if (regions.length === 0) return undefined;
    const widest = Math.max(...regions.map((region) => region.box.right - region.box.left));
    const barcodeWidth = barcode.box.right - barcode.box.left;
    const usefulHeight = regions.reduce((total, region) => total + height(region.box), 0);
    const fixedHeight = COMPACT_MARGIN_PT * 2 + GAP_PT * (regions.length - 1) + STRIP_GAP_PT + STRIP_HEIGHT_PT;
    const scaleWith = (table: number) => Math.min(1, (page.heightPt - fixedHeight - table) / usefulHeight, (page.widthPt + 0.5) / widest);
    // The label keeps priority: rows that would push it below the legibility floor are summarized instead.
    const shown = items ? fittingRows(items.length, (table) => scaleWith(table) >= MIN_COMPACT_SCALE) : 0;
    if (shown === undefined || barcodeWidth > page.widthPt - 2 * STRIP_SIDE_PT + 0.5) throw new EngineError("format_too_small");
    const scale = scaleWith(items ? tableHeight(shown, items.length) : 0);
    if (scale < MIN_COMPACT_SCALE) throw new EngineError("format_too_small");

    const { placed, bottom } = stack(regions, page.widthPt, page.heightPt - COMPACT_MARGIN_PT, scale);
    const titleTop = bottom - STRIP_GAP_PT;
    const titleBar = { left: STRIP_SIDE_PT, right: page.widthPt - STRIP_SIDE_PT, top: titleTop, bottom: titleTop - STRIP_TITLE_PT };
    const lineBaseline = titleBar.bottom - STRIP_LINE_PT + 2;
    const barcodeTop = titleBar.bottom - STRIP_LINE_PT - 2;
    const barcodeLeft = (page.widthPt - barcodeWidth) / 2;
    const barcodeOutputBox = { left: barcodeLeft, right: barcodeLeft + barcodeWidth, top: barcodeTop, bottom: barcodeTop - STRIP_BARCODE_PT };
    // A 1D barcode reads the same from any horizontal slice: keep its full width and a central band.
    const middle = (barcode.box.top + barcode.box.bottom) / 2;
    const barcodeSourceBox = { left: barcode.box.left, right: barcode.box.right, top: middle + STRIP_BARCODE_PT / 2, bottom: middle - STRIP_BARCODE_PT / 2 };
    if (height(barcode.box) < STRIP_BARCODE_PT) return undefined;
    const fiscalStrip: FiscalStrip = {
      summary,
      codeId: barcode.id,
      pageNumber: barcode.pageNumber,
      titleBar,
      lineBaseline,
      barcodeSourceBox,
      barcodeOutputBox,
      digitsBaseline: barcodeOutputBox.bottom - STRIP_DIGITS_PT + 2,
    };
    return {
      extraction,
      ...page,
      scale,
      regions: placed,
      protectedCodes: [
        ...placeCodes(extraction, placed, scale, barcode.id),
        { ...barcode, box: barcodeSourceBox, outputBox: barcodeOutputBox },
      ],
      fiscalStrip,
      ...(items ? { itemsTable: itemsTable(page.widthPt, barcodeOutputBox.bottom - STRIP_DIGITS_PT, items, shown) } : {}),
    };
  }
}

export const createLayout = (extraction: Extraction, outputSize: OutputSize, options?: ConversionOptions) =>
  new SafeLayoutEngine().layout(extraction, outputSize, options);
