import { PDFDocument, PDFFont, PDFPage, rgb, StandardFonts } from "pdf-lib";

import {
  filterBySector,
  itemRows,
  type ListOrder,
  type Order,
  summarizeBySku,
  totalUnits,
} from "./order";

const POINTS_PER_MM = 72 / 25.4;

export type PickingListPaper = "10x15" | "a4";

export type PickingListOptions = {
  /** Shown in the header, e.g. "Mercado Livre". */
  marketplaceLabel: string;
  /** How the rows are laid out; defaults to one block per order. */
  order?: ListOrder;
  /** Physical paper; defaults to a single 10 × 15 column. */
  paper?: PickingListPaper;
  /** A4 only: target orders per page (density). Ignored on 10 × 15. */
  perPage?: 15 | 30 | 50;
  /** Keep only orders whose SKU starts with one of these prefixes. */
  sectorPrefixes?: readonly string[];
  /** Print buyer + sale id under each order (never stored, only drawn). */
  showSaleData?: boolean;
  /** Header timestamp; defaults to now. Injected so tests are deterministic. */
  generatedAt?: Date;
};

const PAPER_MM: Record<PickingListPaper, { width: number; height: number }> = {
  "10x15": { width: 100, height: 150 },
  a4: { width: 210, height: 297 },
};

const MODE_LABEL: Record<ListOrder, string> = {
  sequence: "por pedido",
  "group-sku": "agrupada por SKU",
  "sum-sku": "soma por SKU",
};

const INK = rgb(0.06, 0.06, 0.06);
const MUTED = rgb(0.4, 0.4, 0.4);
const ALERT = rgb(0.72, 0.09, 0.12);

/** Keeps only characters the standard (WinAnsi) fonts can encode, mapping the
 * common typographic punctuation to ASCII and dropping anything else, so an
 * order title with an emoji or exotic glyph never throws mid-render. */
function safe(text: string): string {
  return text
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x20-\x7E -ÿ]/g, "");
}

function truncate(font: PDFFont, text: string, size: number, maxWidth: number): string {
  const clean = safe(text);
  if (font.widthOfTextAtSize(clean, size) <= maxWidth) return clean;
  const ellipsis = "...";
  let lo = 0;
  let hi = clean.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = clean.slice(0, mid) + ellipsis;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return clean.slice(0, lo) + ellipsis;
}

function skuAndVariation(sku: string | undefined, variation: string | undefined, title: string): string {
  const head = sku?.trim() || title;
  return variation?.trim() ? `${head} · ${variation.trim()}` : head;
}

/** One flowable unit: a measured height and a closure that draws it at a y. */
type Block = { height: number; draw: (page: PDFPage, y: number) => void };

/**
 * Builds the lote's picking list as its own PDF. It reads only structured order
 * data (never the source document), so it is independent of any marketplace
 * layout: the "por pedido / agrupada / soma por SKU" orders, the 10 × 15 vs. A4
 * paper, the sector filter and the optional sale data all operate on the data
 * from ./order. The data itself is produced by a marketplace extractor.
 */
export async function buildPickingListPdf(orders: readonly Order[], options: PickingListOptions): Promise<Uint8Array> {
  const mode: ListOrder = options.order ?? "sequence";
  const paper: PickingListPaper = options.paper ?? "10x15";
  const filtered = filterBySector(orders, options.sectorPrefixes ?? []);

  const doc = await PDFDocument.create();
  doc.setProducer("UNO PDF Engine");
  doc.setCreator("UNO");
  doc.setTitle("Lista de separação");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const size = PAPER_MM[paper];
  const pageWidth = size.width * POINTS_PER_MM;
  const pageHeight = size.height * POINTS_PER_MM;
  const margin = paper === "a4" ? 28 : 8;
  const bodySize = paper === "a4" ? 9 : 7.5;
  const lineHeight = bodySize + 3.5;
  const left = margin;
  const contentWidth = pageWidth - margin * 2;
  const checkbox = bodySize + 1;
  const textLeft = left + checkbox + 5;
  const textWidth = contentWidth - checkbox - 5;

  const generatedAt = options.generatedAt ?? new Date();
  const stamp = new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Sao_Paulo",
  }).format(generatedAt);
  const headerLines = [
    { text: "Lista de separação", font: bold, size: paper === "a4" ? 15 : 11, color: INK },
    {
      text: `${safe(options.marketplaceLabel)} · ${MODE_LABEL[mode]} · ${stamp}`,
      font,
      size: bodySize,
      color: MUTED,
    },
    {
      text: `${filtered.length} pedido${filtered.length === 1 ? "" : "s"} · ${totalUnits(filtered)} unidade${totalUnits(filtered) === 1 ? "" : "s"}`,
      font: bold,
      size: bodySize,
      color: INK,
    },
  ];
  const headerHeight = headerLines.reduce((sum, line) => sum + line.size + 4, 0) + 8;

  const drawCheckbox = (page: PDFPage, y: number) => {
    page.drawRectangle({
      x: left,
      y: y - checkbox + 1,
      width: checkbox,
      height: checkbox,
      borderColor: MUTED,
      borderWidth: 0.75,
    });
  };

  const blocks: Block[] = buildBlocks(mode, filtered, {
    font,
    bold,
    bodySize,
    lineHeight,
    textLeft,
    textWidth,
    showSaleData: options.showSaleData ?? false,
    drawCheckbox,
    left,
    contentRight: left + contentWidth,
  });

  // Flow the blocks across pages, honoring the A4 density target as a minimum
  // slot height for short rows while letting dense orders take the room they need.
  const minSlot = paper === "a4" && options.perPage ? (pageHeight - margin * 2 - headerHeight) / options.perPage : 0;
  let page = doc.addPage([pageWidth, pageHeight]);
  let cursor = pageHeight - margin;
  cursor = drawHeader(page, headerLines, left, cursor);
  const bottom = margin;

  if (blocks.length === 0) {
    page.drawText("Nenhum pedido para listar.", { x: left, y: cursor - lineHeight, size: bodySize, font, color: MUTED });
  }

  for (const block of blocks) {
    if (cursor - block.height < bottom) {
      page = doc.addPage([pageWidth, pageHeight]);
      cursor = pageHeight - margin;
    }
    block.draw(page, cursor);
    cursor -= Math.max(block.height, minSlot);
  }

  return doc.save({ useObjectStreams: true });
}

function drawHeader(
  page: PDFPage,
  lines: { text: string; font: PDFFont; size: number; color: ReturnType<typeof rgb> }[],
  left: number,
  top: number,
): number {
  let y = top;
  for (const line of lines) {
    y -= line.size + 4;
    page.drawText(line.text, { x: left, y, size: line.size, font: line.font, color: line.color });
  }
  const { width } = page.getSize();
  y -= 4;
  page.drawLine({ start: { x: left, y }, end: { x: width - left, y }, thickness: 0.75, color: MUTED });
  return y - 6;
}

type BlockContext = {
  font: PDFFont;
  bold: PDFFont;
  bodySize: number;
  lineHeight: number;
  textLeft: number;
  textWidth: number;
  showSaleData: boolean;
  drawCheckbox: (page: PDFPage, y: number) => void;
  left: number;
  contentRight: number;
};

function buildBlocks(mode: ListOrder, orders: readonly Order[], ctx: BlockContext): Block[] {
  if (mode === "sum-sku") {
    return summarizeBySku(orders).map((row) => {
      const labelsLine = `Etiquetas: ${row.labels.join("  ")}`;
      const height = ctx.lineHeight + ctx.bodySize + 2 + 6;
      return {
        height,
        draw: (page, y) => {
          ctx.drawCheckbox(page, y);
          drawItemLine(page, y, ctx, row.quantity, row.sku, row.variation, row.title);
          page.drawText(truncate(ctx.font, labelsLine, ctx.bodySize - 1, ctx.textWidth), {
            x: ctx.textLeft,
            y: y - ctx.lineHeight,
            size: ctx.bodySize - 1,
            font: ctx.font,
            color: MUTED,
          });
        },
      };
    });
  }

  if (mode === "group-sku") {
    return itemRows(orders, true).map(({ label, item }) => ({
      height: ctx.lineHeight + 5,
      draw: (page, y) => {
        ctx.drawCheckbox(page, y);
        drawItemLine(page, y, ctx, item.quantity, item.sku, item.variation, item.title, label);
      },
    }));
  }

  // sequence: one block per order, its items listed under an order header line.
  return orders.map((order) => {
    const saleLine = ctx.showSaleData && (order.buyer || order.saleId)
      ? [order.buyer, order.saleId ? `venda ${order.saleId}` : undefined].filter(Boolean).join(" · ")
      : undefined;
    const height = ctx.lineHeight + (saleLine ? ctx.bodySize + 1 : 0) + order.items.length * ctx.lineHeight + 8;
    return {
      height,
      draw: (page, y) => {
        ctx.drawCheckbox(page, y);
        page.drawText(safe(order.label), { x: ctx.textLeft, y: y - ctx.bodySize, size: ctx.bodySize + 1, font: ctx.bold, color: INK });
        let lineY = y;
        if (saleLine) {
          lineY -= ctx.bodySize + 1;
          page.drawText(truncate(ctx.font, saleLine, ctx.bodySize - 1, ctx.textWidth), {
            x: ctx.textLeft,
            y: lineY - ctx.bodySize,
            size: ctx.bodySize - 1,
            font: ctx.font,
            color: MUTED,
          });
        }
        for (const item of order.items) {
          lineY -= ctx.lineHeight;
          drawItemLine(page, lineY, ctx, item.quantity, item.sku, item.variation, item.title);
        }
        // dashed separator between orders
        const sepY = y - height + 5;
        page.drawLine({
          start: { x: ctx.left, y: sepY },
          end: { x: ctx.contentRight, y: sepY },
          thickness: 0.5,
          color: MUTED,
          dashArray: [2, 2],
        });
      },
    };
  });
}

/** Draws "Nx  SKU · variação — título" with a quantity badge, optionally prefixed
 * by the order label (used by the grouped list). qty > 1 is flagged in red. */
function drawItemLine(
  page: PDFPage,
  y: number,
  ctx: BlockContext,
  quantity: number,
  sku: string | undefined,
  variation: string | undefined,
  title: string,
  label?: string,
): void {
  const baseY = y - ctx.bodySize;
  let x = ctx.textLeft;
  if (label) {
    const text = `${safe(label)}  `;
    page.drawText(text, { x, y: baseY, size: ctx.bodySize, font: ctx.bold, color: INK });
    x += ctx.bold.widthOfTextAtSize(text, ctx.bodySize);
  }
  const qtyText = `${quantity}x  `;
  const qtyColor = quantity > 1 ? ALERT : INK;
  page.drawText(qtyText, { x, y: baseY, size: ctx.bodySize, font: ctx.bold, color: qtyColor });
  x += ctx.bold.widthOfTextAtSize(qtyText, ctx.bodySize);

  const remaining = ctx.textLeft + ctx.textWidth - x;
  const body = skuAndVariation(sku, variation, title) + (sku ? ` — ${title}` : "");
  page.drawText(truncate(ctx.font, body, ctx.bodySize, Math.max(remaining, 20)), {
    x,
    y: baseY,
    size: ctx.bodySize,
    font: ctx.font,
    color: INK,
  });

  if (quantity > 1) {
    const alert = "ATENÇÃO À QUANTIDADE";
    const alertSize = ctx.bodySize - 1.5;
    const alertWidth = ctx.bold.widthOfTextAtSize(safe(alert), alertSize);
    page.drawText(safe(alert), {
      x: ctx.textLeft + ctx.textWidth - alertWidth,
      y: baseY,
      size: alertSize,
      font: ctx.bold,
      color: ALERT,
    });
  }
}
