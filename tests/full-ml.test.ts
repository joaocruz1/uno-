import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { convertFullMlBatch, ZplError } from "@/engine/marketplace";

const label = (code: string) => `^XA^CI28^PW800^LL1200^LH0,0
^FO40,40^A0N,40,40^FDMERCADO LIVRE FULL^FS
^FO40,100^BY3^BCN,160,Y,N,N^FD${code}^FS
^FO40,330^A0N,30,30^FDSKU: LSR-X^FS
^XZ`;

describe("convertFullMlBatch", () => {
  it("renders each ^XA block to a 10×15 page whose barcode decodes", async () => {
    const result = await convertFullMlBatch(`${label("7899000000017")}\n${label("7899000000024")}`);
    expect(result.marketplace).toBe("mercado-livre");
    expect(result.orderCount).toBe(2);
    expect(result.succeeded).toBe(2);
    const doc = await PDFDocument.load(result.bytes);
    expect(doc.getPageCount()).toBe(2);
    expect(Math.round(doc.getPage(0).getWidth())).toBe(283);
    expect(Math.round(doc.getPage(0).getHeight())).toBe(425);
  }, 20_000);

  it("prints ^PQ copies", async () => {
    const result = await convertFullMlBatch(`^XA^PW800^LL1200^FO40,100^BY3^BCN,160,Y,N,N^FD7899000000017^FS^PQ2^XZ`);
    expect(result.orderCount).toBe(2);
    expect(result.succeeded).toBe(2);
  }, 20_000);

  it("refuses an unsupported barcode command without failing the lote", async () => {
    const result = await convertFullMlBatch(`${label("7899000000017")}\n^XA^PW800^LL1200^FO40,100^BQN,2,6^FDQA,oi^FS^XZ`);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.outcomes.find((outcome) => !outcome.ok)?.errorCode).toBe("zpl_render_unavailable");
  }, 20_000);

  it("rejects an empty document", async () => {
    await expect(convertFullMlBatch("sem blocos")).rejects.toBeInstanceOf(ZplError);
  });
});
