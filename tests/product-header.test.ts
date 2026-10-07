import { describe, expect, it } from "vitest";

import { parseProductFields, productHeaderSchema } from "@/lib/product-header";
import { parseEffectiveMultipartOptions, publicRequestFingerprint } from "@/server/api-ingestion/admission";

describe("product header input", () => {
  it("is absent unless a product field is sent and defaults the quantity to one", () => {
    expect(parseProductFields({})).toBeUndefined();
    expect(parseProductFields({ productTitle: " Produto sintetico " })).toEqual({ quantity: 1, title: "Produto sintetico" });
    expect(parseProductFields({ productTitle: "Produto", quantity: "12", sku: "SKU-1", variation: "Cor: Azul" }))
      .toEqual({ quantity: 12, title: "Produto", sku: "SKU-1", variation: "Cor: Azul" });
  });

  it("rejects incomplete, malformed or oversized values", () => {
    expect(() => parseProductFields({ sku: "SKU-1" })).toThrow();
    for (const quantity of ["0", "-1", "1.5", "abc", "10000"]) expect(() => parseProductFields({ productTitle: "Produto", quantity })).toThrow();
    expect(() => productHeaderSchema.parse({ quantity: 1, title: "linha\nquebrada" })).toThrow();
    expect(() => productHeaderSchema.parse({ quantity: 1, title: "x".repeat(141) })).toThrow();
    expect(() => productHeaderSchema.parse({ quantity: 1, title: "Produto", price: 10 })).toThrow();
  });

  it("is part of the effective API options and of the idempotency fingerprint", () => {
    const plain = parseEffectiveMultipartOptions({ size: "100x150" });
    const withProduct = parseEffectiveMultipartOptions({ size: "100x150", productTitle: "Produto", quantity: "2" });
    expect(plain.product).toBeUndefined();
    expect(withProduct.product).toEqual({ quantity: 2, title: "Produto" });
    expect(publicRequestFingerprint(plain, [])).not.toBe(publicRequestFingerprint(withProduct, []));
    expect(() => parseEffectiveMultipartOptions({ size: "100x150", quantity: "2" })).toThrowError(expect.objectContaining({ code: "invalid_request" }));
  });
});
