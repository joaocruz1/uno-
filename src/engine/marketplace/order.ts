/**
 * Structured order data that a marketplace extractor produces and that the
 * picking list (./picking-list) renders. Reading these fields from a real
 * `*_labels.pdf` is the extractor's job; everything here operates on the data,
 * so it is independent of any one marketplace's layout.
 */

export type OrderItem = {
  sku?: string;
  variation?: string;
  title: string;
  quantity: number;
};

export type Order = {
  /** Sequence identifier shown on the label and in the list, e.g. "C1". */
  label: string;
  /** Marketplace sale/order number, for the optional "dados da venda" line. */
  saleId?: string;
  buyer?: string;
  items: OrderItem[];
};

export type ListOrder = "sequence" | "group-sku" | "sum-sku";

/** One flattened (order, item) row, used by the "group by SKU" list. */
export type ItemRow = { label: string; item: OrderItem };

/** One SKU aggregated across the lote, used by the "sum by SKU" list. */
export type SummedRow = {
  sku: string;
  variation?: string;
  title: string;
  quantity: number;
  /** Labels of the orders that contain this SKU, in order. */
  labels: string[];
};

export function totalUnits(orders: readonly Order[]): number {
  return orders.reduce((sum, order) => sum + order.items.reduce((inner, item) => inner + item.quantity, 0), 0);
}

/** Keeps only the orders that have at least one item whose SKU starts with one
 * of the given prefixes (case-insensitive). An empty prefix list keeps all. */
export function filterBySector(orders: readonly Order[], prefixes: readonly string[]): Order[] {
  const cleaned = prefixes.map((prefix) => prefix.trim().toUpperCase()).filter(Boolean);
  if (cleaned.length === 0) return [...orders];
  return orders.filter((order) =>
    order.items.some((item) => {
      const sku = item.sku?.trim().toUpperCase();
      return sku !== undefined && cleaned.some((prefix) => sku.startsWith(prefix));
    }),
  );
}

/** Flattens every item to its own row, optionally sorted so equal SKUs are adjacent. */
export function itemRows(orders: readonly Order[], groupBySku: boolean): ItemRow[] {
  const rows: ItemRow[] = [];
  for (const order of orders) for (const item of order.items) rows.push({ label: order.label, item });
  if (!groupBySku) return rows;
  return rows.sort((a, b) =>
    (a.item.sku ?? a.item.title).localeCompare(b.item.sku ?? b.item.title, "pt-BR") ||
    (a.item.variation ?? "").localeCompare(b.item.variation ?? "", "pt-BR"),
  );
}

/** Aggregates quantity per (SKU, variation) across the lote, keeping the source labels. */
export function summarizeBySku(orders: readonly Order[]): SummedRow[] {
  const map = new Map<string, SummedRow>();
  for (const order of orders) {
    for (const item of order.items) {
      const sku = item.sku ?? item.title;
      const key = `${sku}\u0000${item.variation ?? ""}`;
      const existing = map.get(key);
      if (existing) {
        existing.quantity += item.quantity;
        if (!existing.labels.includes(order.label)) existing.labels.push(order.label);
      } else {
        map.set(key, { sku, variation: item.variation, title: item.title, quantity: item.quantity, labels: [order.label] });
      }
    }
  }
  return [...map.values()].sort((a, b) => a.sku.localeCompare(b.sku, "pt-BR") || (a.variation ?? "").localeCompare(b.variation ?? "", "pt-BR"));
}
