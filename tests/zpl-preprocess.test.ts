import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { createZplRenderer, DEFAULT_ZPL_LIMITS, preprocessZpl, ZplError } from "@/engine/marketplace";

const LABEL = (body: string) => `^XA${body}^XZ`;

describe("preprocessZpl", () => {
  it("splits a multi-label file into blocks and counts ^PQ copies", () => {
    const zpl = LABEL("^FO50,50^FDum^FS") + "\n" + LABEL("^FO50,50^FDdois^FS^PQ3");
    const doc = preprocessZpl(zpl);
    expect(doc.blocks).toHaveLength(2);
    expect(doc.blocks[0].copies).toBe(1);
    expect(doc.blocks[1].copies).toBe(3);
    expect(doc.totalLabels).toBe(4);
    expect(doc.blocks[0].raw.startsWith("^XA")).toBe(true);
    expect(doc.blocks[0].raw.endsWith("^XZ")).toBe(true);
  });

  it("clamps ^PQ to the copies ceiling", () => {
    const doc = preprocessZpl(LABEL("^FDx^FS^PQ9999"), { maxCopies: 10 });
    expect(doc.blocks[0].copies).toBe(10);
  });

  it("rejects an empty or label-less file", () => {
    expect(() => preprocessZpl("não é zpl")).toThrowError(ZplError);
    try {
      preprocessZpl("");
    } catch (error) {
      expect((error as ZplError).code).toBe("zpl_empty");
    }
  });

  it("rejects input over the byte ceiling", () => {
    const big = LABEL("^FD" + "x".repeat(200) + "^FS");
    try {
      preprocessZpl(big, { maxBytes: 50 });
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as ZplError).code).toBe("zpl_too_large");
    }
  });

  it("rejects a file with more label blocks than allowed", () => {
    const many = Array.from({ length: 5 }, () => LABEL("^FDx^FS")).join("");
    try {
      preprocessZpl(many, { maxBlocks: 3 });
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as ZplError).code).toBe("zpl_too_many_blocks");
    }
  });

  it("accepts a :Z64: graphic field that stays under the decoded cap", () => {
    const payload = deflateSync(Buffer.alloc(1024, 1)).toString("base64");
    const doc = preprocessZpl(LABEL(`^GFA,1024,1024,16,:Z64:${payload}:abcd`));
    expect(doc.decodedGraphicBytes).toBe(1024);
  });

  it("rejects a :Z64: compression bomb (decoded size over the cap)", () => {
    const payload = deflateSync(Buffer.alloc(2 * 1024 * 1024, 0)).toString("base64");
    try {
      preprocessZpl(LABEL(`^GFA,0,0,0,:Z64:${payload}:0000`), { maxDecodedBytesPerField: 64 * 1024 });
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as ZplError).code).toBe("zpl_decompression_bomb");
    }
  });

  it("exposes sane default limits", () => {
    expect(DEFAULT_ZPL_LIMITS.maxBytes).toBeGreaterThan(0);
    expect(DEFAULT_ZPL_LIMITS.maxBlocks).toBeGreaterThan(0);
  });
});

describe("ZplRenderer", () => {
  it("refuses to render until a real engine is validated", async () => {
    const doc = preprocessZpl(LABEL("^FDx^FS"));
    await expect(createZplRenderer().render(doc, { dpmm: 12, widthMm: 100, heightMm: 150 })).rejects.toMatchObject({
      name: "ZplError",
      code: "zpl_render_unavailable",
    });
  });
});
