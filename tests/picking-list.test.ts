import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import {
  buildPickingListPdf,
  extractMercadoLivreOrders,
  filterBySector,
  itemRows,
  MarketplaceError,
  orderExtractorFor,
  summarizeBySku,
  totalUnits,
} from "@/engine/marketplace";
import { manySyntheticOrders, syntheticOrders } from "./fixtures/synthetic-orders";

const A4 = { width: 595.2756, height: 841.8898 };
const TEN_BY_FIFTEEN = { width: 283.4646, height: 425.1969 };

describe("order transforms", () => {
  it("counts total units across every item", () => {
    expect(totalUnits(syntheticOrders())).toBe(8);
  });

  it("filters orders by SKU prefix (keeps the whole order)", () => {
    const orders = syntheticOrders();
    expect(filterBySector(orders, []).map((o) => o.label)).toEqual(["C1", "C2", "C3", "C4"]);
    expect(filterBySector(orders, ["AZ"]).map((o) => o.label)).toEqual(["C1", "C2", "C3"]);
    expect(filterBySector(orders, ["VD"]).map((o) => o.label)).toEqual(["C3"]);
    expect(filterBySector(orders, ["xp"]).map((o) => o.label)).toEqual(["C4"]);
    expect(filterBySector(orders, ["AZ", "XP"]).map((o) => o.label)).toEqual(["C1", "C2", "C3", "C4"]);
  });

  it("sums quantities per (SKU, variação) and keeps the source labels", () => {
    const rows = summarizeBySku(syntheticOrders());
    expect(rows.map((r) => [r.sku, r.variation, r.quantity, r.labels])).toEqual([
      ["AZ-01", "M", 2, ["C2"]],
      ["AZ-01", "P", 2, ["C1", "C3"]],
      ["VD-09", "G", 3, ["C3"]],
      ["XP-77", undefined, 1, ["C4"]],
    ]);
  });

  it("flattens items and, when grouping, puts equal SKUs next to each other", () => {
    const flat = itemRows(syntheticOrders(), false);
    expect(flat).toHaveLength(5);

    const grouped = itemRows(syntheticOrders(), true);
    const skus = grouped.map((r) => r.item.sku);
    // equal SKUs are contiguous
    for (let i = 1; i < skus.length; i += 1) {
      if (skus[i] === skus[0]) expect(skus.slice(0, i + 1).every((s) => s === skus[0])).toBe(true);
    }
    expect(skus).toEqual(["AZ-01", "AZ-01", "AZ-01", "VD-09", "XP-77"]);
  });
});

describe("picking-list PDF", () => {
  const generatedAt = new Date("2026-10-10T12:00:00Z");

  it("renders a 10×15 list, one page, for the sequence mode", async () => {
    const bytes = await buildPickingListPdf(syntheticOrders(), { marketplaceLabel: "Mercado Livre", generatedAt });
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(pdf.getPage(0).getWidth()).toBeCloseTo(TEN_BY_FIFTEEN.width, 1);
    expect(pdf.getPage(0).getHeight()).toBeCloseTo(TEN_BY_FIFTEEN.height, 1);
  });

  it("renders an A4 list", async () => {
    const bytes = await buildPickingListPdf(syntheticOrders(), {
      marketplaceLabel: "Mercado Livre",
      paper: "a4",
      order: "sum-sku",
      generatedAt,
    });
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPage(0).getWidth()).toBeCloseTo(A4.width, 1);
    expect(pdf.getPage(0).getHeight()).toBeCloseTo(A4.height, 1);
  });

  it("builds every mode and the sale-data variant without throwing", async () => {
    for (const order of ["sequence", "group-sku", "sum-sku"] as const) {
      const bytes = await buildPickingListPdf(syntheticOrders(), { marketplaceLabel: "Mercado Livre", order, showSaleData: true, generatedAt });
      expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThanOrEqual(1);
    }
  });

  it("paginates a large lote across pages (A4, sum by SKU)", async () => {
    const bytes = await buildPickingListPdf(manySyntheticOrders(90), {
      marketplaceLabel: "Mercado Livre",
      paper: "a4",
      order: "sum-sku",
      perPage: 30,
      generatedAt,
    });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThanOrEqual(2);
  });

  it("applies the sector filter before rendering", async () => {
    const bytes = await buildPickingListPdf(syntheticOrders(), {
      marketplaceLabel: "Mercado Livre",
      sectorPrefixes: ["VD"],
      generatedAt,
    });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });

  it("still renders a page when the filter removes every order", async () => {
    const bytes = await buildPickingListPdf(syntheticOrders(), {
      marketplaceLabel: "Mercado Livre",
      sectorPrefixes: ["NAO-EXISTE"],
      generatedAt,
    });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });
});

describe("order extraction", () => {
  it("refuses with a typed error until a real sample pins the ML layout", async () => {
    await expect(extractMercadoLivreOrders(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
      name: "MarketplaceError",
      code: "extraction_unavailable",
    });
    await expect(orderExtractorFor("mercado-livre").extract(new Uint8Array())).rejects.toBeInstanceOf(MarketplaceError);
  });
});
