import type { Order } from "@/engine/marketplace";

/**
 * A small, fully deterministic set of orders for the picking-list engine, with
 * repeated SKUs across orders, distinct variations of one SKU, a multi-item
 * order and one item without a SKU — enough to exercise grouping, summing and
 * the sector filter. All values are synthetic (no real buyer or marketplace data).
 *
 * Totals: 4 orders, 8 units. By (SKU, variação):
 *   AZ-01·M → 2 un. [C2]   AZ-01·P → 2 un. [C1, C3]
 *   VD-09·G → 3 un. [C3]   XP-77   → 1 un. [C4]
 */
export function syntheticOrders(): Order[] {
  return [
    { label: "C1", saleId: "2000001", buyer: "Ana Souza", items: [{ sku: "AZ-01", variation: "P", title: "Camiseta azul", quantity: 1 }] },
    { label: "C2", saleId: "2000002", buyer: "Bruno Lima", items: [{ sku: "AZ-01", variation: "M", title: "Camiseta azul", quantity: 2 }] },
    {
      label: "C3",
      saleId: "2000003",
      buyer: "Caio Dias",
      items: [
        { sku: "VD-09", variation: "G", title: "Caneca verde", quantity: 3 },
        { sku: "AZ-01", variation: "P", title: "Camiseta azul", quantity: 1 },
      ],
    },
    { label: "C4", saleId: "2000004", buyer: "Duda Reis", items: [{ sku: "XP-77", title: "Produto sem variação", quantity: 1 }] },
  ];
}

/** N single-item orders with distinct SKUs, for pagination tests. */
export function manySyntheticOrders(count: number): Order[] {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    return {
      label: `C${n}`,
      saleId: `30000${n}`,
      buyer: `Cliente ${n}`,
      items: [{ sku: `SK-${String(n).padStart(4, "0")}`, title: `Produto ${n}`, quantity: 1 }],
    } satisfies Order;
  });
}
