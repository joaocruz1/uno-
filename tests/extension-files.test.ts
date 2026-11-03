import { describe, expect, it } from "vitest";

import { base64ToBytes, bytesToBase64, conversionFor, dataUrlBytes, looksConvertible, outputName, sniffKind } from "../extension/src/files.js";
import { marketplaceFor } from "../extension/src/marketplaces.js";

const ascii = (text: string) => new TextEncoder().encode(text);

describe("extension: which downloads it touches", () => {
  it("recognizes seller-center downloads by URL, referrer or blob origin", () => {
    expect(marketplaceFor("blob:https://seller.shopee.com.br/1f2e")).toBe("shopee");
    expect(marketplaceFor("https://cdn.example.com/x.pdf", "https://www.mercadolivre.com.br/vendas/omni/lista")).toBe("mercado-livre");
    expect(marketplaceFor("https://api.mercadolibre.com/shipment_labels?x=1")).toBe("mercado-livre");
    expect(marketplaceFor("https://seller-br.tiktok.com/order")).toBe("tiktok");
    expect(marketplaceFor("https://notmercadolivre.com.br/x.pdf", "https://evil-shopee.com.br")).toBeNull();
    expect(marketplaceFor("data:application/pdf;base64,AA==", "", undefined)).toBeNull();
  });

  it("pauses PDFs, ZPL and generic streams but lets spreadsheets, zips and images through", () => {
    expect(looksConvertible({ mime: "application/pdf", filename: "", url: "blob:x" })).toBe(true);
    expect(looksConvertible({ mime: "application/octet-stream", url: "https://a/labels" })).toBe(true);
    expect(looksConvertible({ mime: "text/plain", filename: "/Downloads/etiquetas.zpl", url: "" })).toBe(true);
    expect(looksConvertible({ mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: "pedidos.xlsx", url: "" })).toBe(false);
    expect(looksConvertible({ mime: "application/zip", url: "https://a/etiquetas.zip?sig=1" })).toBe(false);
    expect(looksConvertible({ mime: "image/png", url: "https://a/logo" })).toBe(false);
  });

  it("decides by content: PDF anywhere in the header, ZPL only from Mercado Livre", () => {
    expect(sniffKind(ascii("\n%PDF-1.7\n..."))).toBe("pdf");
    expect(sniffKind(ascii("^XA^FO50,50^FDx^FS^XZ"))).toBe("zpl");
    expect(sniffKind(ascii("PK\u0003\u0004"))).toBeNull();
    expect(conversionFor("mercado-livre", "zpl")).toBe("mercado-livre-full");
    expect(conversionFor("shopee", "zpl")).toBeNull();
    expect(conversionFor("tiktok", "pdf")).toBe("tiktok");
    expect(conversionFor("shopee", null)).toBeNull();
  });

  it("round-trips bytes and reads data URLs", () => {
    const bytes = new Uint8Array(70_000).map((_, index) => index % 251);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    expect(dataUrlBytes("data:application/pdf;base64,JVBERi0=")).toEqual(ascii("%PDF-"));
    expect(dataUrlBytes("data:text/plain,%5EXA")).toEqual(ascii("^XA"));
    expect(outputName("shopee", new Date(2026, 10, 3, 9, 5))).toBe("uno-shopee-2026-11-03-0905.pdf");
  });
});
