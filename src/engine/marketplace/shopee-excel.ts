import type { Order, OrderItem } from "./order";

/**
 * Shopee packing-list (lista de embalagem) Excel reader. Shopee gives SKU,
 * variação and quantidade in a spreadsheet with ONE ROW PER ITEM, keyed by the
 * order id — the label PDF carries no item detail, so the rodapé and the picking
 * list come from here (plan, Fase 2 / Apêndice E).
 *
 * Two layers, split on purpose:
 *  - the byte guards and the matrix→orders mapping below are independent of the
 *    xlsx binary format, so they are built and tested now;
 *  - decoding the .xlsx bytes to a cell matrix is a vendored-SheetJS job (CE
 *    0.20.3, read-only, anti zip-bomb) behind {@link ShopeeWorkbookReader}, and
 *    stays gated until that is vendored and validated against a real export.
 *
 * Runs inside the isolated engine process; the values read are drawn on the
 * user's own labels/list and never persisted (privacy posture).
 */

export type ShopeeErrorCode =
  | "shopee_file_too_large"
  | "shopee_bad_signature"
  | "shopee_missing_columns"
  | "shopee_empty"
  | "shopee_excel_unavailable";

const SAFE_MESSAGES: Record<ShopeeErrorCode, string> = {
  shopee_file_too_large: "A planilha é maior do que o limite aceito.",
  shopee_bad_signature: "O arquivo não parece ser uma planilha Excel (.xlsx/.xls).",
  shopee_missing_columns: "A planilha não tem as colunas esperadas (pedido, SKU e quantidade).",
  shopee_empty: "A planilha não tem linhas de itens.",
  shopee_excel_unavailable: "A leitura de planilha Excel ainda não está disponível.",
};

export class ShopeeError extends Error {
  constructor(
    readonly code: ShopeeErrorCode,
    message?: string,
  ) {
    super(message ?? SAFE_MESSAGES[code]);
    this.name = "ShopeeError";
  }
}

/** Default spreadsheet byte ceiling (10 MiB). */
export const SHOPEE_MAX_BYTES = 10 * 1024 * 1024;

const XLSX_SIGNATURE = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04 (zip)
const XLS_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]; // OLE compound file

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

/**
 * Cheap, format-level gate before any parsing: bounds the size and confirms the
 * magic bytes of a real .xlsx (zip) or .xls (OLE). The uncompressed-size /
 * entry-count zip-bomb check and the safe SheetJS read options
 * ({@link ShopeeWorkbookReader}) are the vendored step layered on top of this.
 */
export function assertSpreadsheetSafe(bytes: Uint8Array, maxBytes: number = SHOPEE_MAX_BYTES): void {
  if (bytes.byteLength > maxBytes) {
    throw new ShopeeError("shopee_file_too_large", `A planilha tem ${bytes.byteLength} bytes; o limite é ${maxBytes}.`);
  }
  if (!startsWith(bytes, XLSX_SIGNATURE) && !startsWith(bytes, XLS_SIGNATURE)) {
    throw new ShopeeError("shopee_bad_signature");
  }
}

/** Lowercases, strips accents and collapses whitespace/punctuation so header
 * matching survives the small wording changes Shopee makes between exports. */
export function normalizeHeader(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Mapped by normalized header; the first candidate found wins. Order id is the
// official key (Apêndice E); tracking is the fallback some tools key on instead.
const COLUMN_CANDIDATES = {
  orderId: ["id do pedido", "no do pedido", "numero do pedido", "n do pedido", "order id", "id pedido", "codigo do pedido"],
  tracking: ["numero de rastreamento", "rastreamento", "rastreio", "tracking number", "tracking"],
  sku: ["numero de referencia sku", "sku de referencia", "sku", "referencia", "codigo sku"],
  variation: ["nome da variacao", "variacao", "variation name", "variation"],
  title: ["nome do produto", "produto", "product name", "nome"],
  quantity: ["quantidade", "qtd", "quantity", "qty"],
} as const;

type ColumnMap = { [K in keyof typeof COLUMN_CANDIDATES]: number };

function resolveColumns(headerRow: readonly string[]): ColumnMap {
  const normalized = headerRow.map(normalizeHeader);
  const find = (candidates: readonly string[]): number => {
    for (const candidate of candidates) {
      const index = normalized.indexOf(candidate);
      if (index !== -1) return index;
    }
    return -1;
  };
  return {
    orderId: find(COLUMN_CANDIDATES.orderId),
    tracking: find(COLUMN_CANDIDATES.tracking),
    sku: find(COLUMN_CANDIDATES.sku),
    variation: find(COLUMN_CANDIDATES.variation),
    title: find(COLUMN_CANDIDATES.title),
    quantity: find(COLUMN_CANDIDATES.quantity),
  };
}

function cell(row: readonly string[], index: number): string {
  return index >= 0 && index < row.length ? String(row[index] ?? "").trim() : "";
}

function parseQuantity(raw: string): number {
  const match = raw.replace(/\./g, "").match(/\d+/);
  const value = match ? Number.parseInt(match[0], 10) : NaN;
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/**
 * Maps a Shopee packing-list cell matrix (header row first) to orders: each data
 * row is one item, grouped by order id (or tracking, when that is the only key
 * present). Columns are found by normalized header name, never by position.
 *
 * The order {@link Order.label} here is the grouping key (order id / tracking) —
 * a placeholder until the label PDF assigns the real sequence number when the
 * two are matched. Everything downstream (grouping, sum, picking list) already
 * consumes the result.
 */
export function parseShopeePacking(matrix: readonly (readonly string[])[]): Order[] {
  if (matrix.length < 2) throw new ShopeeError("shopee_empty");
  const columns = resolveColumns(matrix[0]);
  const key = columns.orderId >= 0 ? columns.orderId : columns.tracking;
  if (key < 0 || columns.sku < 0 || columns.quantity < 0) throw new ShopeeError("shopee_missing_columns");

  const byKey = new Map<string, Order>();
  for (let rowIndex = 1; rowIndex < matrix.length; rowIndex += 1) {
    const row = matrix[rowIndex];
    const keyValue = cell(row, key);
    const sku = cell(row, columns.sku);
    const title = cell(row, columns.title);
    if (!keyValue || (!sku && !title)) continue; // skip blank / non-item rows

    const item: OrderItem = {
      sku: sku || undefined,
      variation: cell(row, columns.variation) || undefined,
      title: title || sku,
      quantity: parseQuantity(cell(row, columns.quantity)),
    };
    const existing = byKey.get(keyValue);
    if (existing) existing.items.push(item);
    else byKey.set(keyValue, { label: keyValue, saleId: cell(row, columns.orderId) || keyValue, items: [item] });
  }

  if (byKey.size === 0) throw new ShopeeError("shopee_empty");
  return [...byKey.values()];
}

/**
 * Decodes Shopee's .xlsx/.xls bytes to a cell matrix. The concrete reader is
 * vendored SheetJS CE 0.20.3 (the npm `xlsx` is stuck at 0.18.5 with
 * CVE-2023-30533), read with `{dense, sheetRows, cellFormula:false, ...}`,
 * password-protected files refused, after the uncompressed-size/entry-count
 * zip-bomb check — all inside the isolated process (plan, Apêndice E). Not
 * vendored yet, so this stays behind the interface.
 */
export interface ShopeeWorkbookReader {
  read(bytes: Uint8Array): string[][];
}

/** No workbook reader is bound until SheetJS is vendored and validated against a
 * real export; refuses with a typed error rather than guessing. */
export function createShopeeWorkbookReader(): ShopeeWorkbookReader {
  return {
    read: () => {
      throw new ShopeeError(
        "shopee_excel_unavailable",
        "A leitura de .xlsx depende do SheetJS CE 0.20.3 vendorizado (lido com opções seguras, anti zip-bomb); o mapeamento das colunas e os guardas de bytes já estão prontos.",
      );
    },
  };
}
