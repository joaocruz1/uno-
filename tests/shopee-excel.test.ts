import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import {
  assertSpreadsheetSafe,
  buildPickingListPdf,
  createShopeeWorkbookReader,
  normalizeHeader,
  parseShopeePacking,
  ShopeeError,
  summarizeBySku,
} from "@/engine/marketplace";

const header = ["Nome do Produto", "Variação", "Número de Referência SKU", "Quantidade", "ID do pedido"];
const matrix = [
  header,
  ["Camiseta azul", "P", "AZ-01", "2", "PED-1"],
  ["Caneca verde", "Verde", "VD-09", "1", "PED-1"],
  ["Camiseta azul", "M", "AZ-01", "3", "PED-2"],
];

describe("normalizeHeader", () => {
  it("strips accents, case and punctuation", () => {
    expect(normalizeHeader("Número de Referência SKU")).toBe("numero de referencia sku");
    expect(normalizeHeader("ID do pedido")).toBe("id do pedido");
    expect(normalizeHeader("  Quantidade  ")).toBe("quantidade");
  });
});

describe("assertSpreadsheetSafe", () => {
  it("accepts a .xlsx (zip) signature", () => {
    expect(() => assertSpreadsheetSafe(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00]))).not.toThrow();
  });

  it("accepts a .xls (OLE) signature", () => {
    expect(() => assertSpreadsheetSafe(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).not.toThrow();
  });

  it("rejects an unknown signature", () => {
    try {
      assertSpreadsheetSafe(new Uint8Array([0, 1, 2, 3]));
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as ShopeeError).code).toBe("shopee_bad_signature");
    }
  });

  it("rejects a file over the byte ceiling", () => {
    try {
      assertSpreadsheetSafe(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]), 4);
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as ShopeeError).code).toBe("shopee_file_too_large");
    }
  });
});

describe("parseShopeePacking", () => {
  it("maps columns by header name and groups items by order id", () => {
    const orders = parseShopeePacking(matrix);
    expect(orders.map((o) => o.label)).toEqual(["PED-1", "PED-2"]);
    expect(orders[0].items).toEqual([
      { sku: "AZ-01", variation: "P", title: "Camiseta azul", quantity: 2 },
      { sku: "VD-09", variation: "Verde", title: "Caneca verde", quantity: 1 },
    ]);
    expect(orders[1].items).toEqual([{ sku: "AZ-01", variation: "M", title: "Camiseta azul", quantity: 3 }]);
  });

  it("finds columns regardless of their position", () => {
    const reordered = [
      ["ID do pedido", "SKU", "Qtd", "Produto"],
      ["PED-9", "XP-77", "4", "Produto X"],
    ];
    const orders = parseShopeePacking(reordered);
    expect(orders).toHaveLength(1);
    expect(orders[0].items[0]).toMatchObject({ sku: "XP-77", quantity: 4, title: "Produto X" });
  });

  it("falls back to tracking when there is no order-id column", () => {
    const orders = parseShopeePacking([
      ["SKU", "Quantidade", "Número de rastreamento"],
      ["AZ-01", "1", "BR123"],
      ["VD-09", "2", "BR123"],
    ]);
    expect(orders).toHaveLength(1);
    expect(orders[0].label).toBe("BR123");
    expect(orders[0].items).toHaveLength(2);
  });

  it("defaults an unreadable quantity to 1 and skips blank rows", () => {
    const orders = parseShopeePacking([
      ["ID do pedido", "SKU", "Quantidade"],
      ["PED-1", "AZ-01", ""],
      ["", "", ""],
    ]);
    expect(orders[0].items[0].quantity).toBe(1);
    expect(orders[0].items).toHaveLength(1);
  });

  it("rejects a sheet missing the required columns", () => {
    try {
      parseShopeePacking([["Produto", "Variação"], ["Camiseta", "P"]]);
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as ShopeeError).code).toBe("shopee_missing_columns");
    }
  });

  it("rejects an empty sheet", () => {
    expect(() => parseShopeePacking([header])).toThrowError(ShopeeError);
  });

  it("feeds straight into the picking-list engine", async () => {
    const orders = parseShopeePacking(matrix);
    const summed = summarizeBySku(orders);
    // AZ-01·M=3, AZ-01·P=2, VD-09·Verde=1
    expect(summed.find((r) => r.variation === "P")?.quantity).toBe(2);
    expect(summed.find((r) => r.variation === "M")?.quantity).toBe(3);
    const bytes = await buildPickingListPdf(orders, { marketplaceLabel: "Shopee", order: "sum-sku", paper: "a4" });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThanOrEqual(1);
  });
});

describe("ShopeeWorkbookReader", () => {
  it("refuses to decode .xlsx until SheetJS is vendored", () => {
    try {
      createShopeeWorkbookReader().read(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as ShopeeError).code).toBe("shopee_excel_unavailable");
    }
  });
});
