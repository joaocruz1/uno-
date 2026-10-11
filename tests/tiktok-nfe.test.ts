import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import {
  combineInterleaved,
  convertTikTokBatch,
  createTikTokExtractor,
  type InvoiceUnit,
  type LabelUnit,
  normalizeTrackingKey,
  planInterleave,
  type TikTokExtractor,
  TikTokError,
} from "@/engine/marketplace";

async function onePagePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([283, 425]);
  return doc.save({ useObjectStreams: true });
}

const label = (key: string, byte = 1): LabelUnit => ({ key, pdf: new Uint8Array([byte]) });
const invoice = (key: string, byte = 9): InvoiceUnit => ({ key, pdf: new Uint8Array([byte]) });

describe("normalizeTrackingKey", () => {
  it("strips separators and uppercases", () => {
    expect(normalizeTrackingKey("br 123-456_789.0")).toBe("BR1234567890");
    expect(normalizeTrackingKey("BR1234567890")).toBe("BR1234567890");
  });
});

describe("planInterleave", () => {
  it("places each label's invoice right after it, in label order", () => {
    const plan = planInterleave(
      [label("A", 1), label("B", 2)],
      [invoice("B", 8), invoice("A", 7)],
    );
    expect(plan.ordered.map((e) => `${e.kind}:${e.key}`)).toEqual(["label:A", "invoice:A", "label:B", "invoice:B"]);
    expect(plan.unmatchedLabels).toEqual([]);
    expect(plan.unmatchedInvoices).toEqual([]);
  });

  it("matches despite spacing/hyphen differences between the two documents", () => {
    const plan = planInterleave([label("BR 123-456")], [invoice("br123456")]);
    expect(plan.ordered).toHaveLength(2);
    expect(plan.unmatchedLabels).toEqual([]);
  });

  it("keeps a label with no invoice and reports it", () => {
    const plan = planInterleave([label("A"), label("B")], [invoice("A")]);
    expect(plan.ordered.map((e) => `${e.kind}:${e.key}`)).toEqual(["label:A", "invoice:A", "label:B"]);
    expect(plan.unmatchedLabels).toEqual(["B"]);
  });

  it("reports an invoice that matched no label", () => {
    const plan = planInterleave([label("A")], [invoice("A"), invoice("Z")]);
    expect(plan.unmatchedInvoices).toEqual(["Z"]);
    expect(plan.ordered).toHaveLength(2);
  });

  it("consumes duplicate-key invoices in input order", () => {
    const plan = planInterleave([label("A"), label("A")], [invoice("A", 10), invoice("A", 11)]);
    const invoiceBytes = plan.ordered.filter((e) => e.kind === "invoice").map((e) => e.pdf[0]);
    expect(invoiceBytes).toEqual([10, 11]);
  });
});

describe("combineInterleaved", () => {
  it("concatenates the planned order into one PDF, one page per entry", async () => {
    const labels = [
      { key: "A", pdf: await onePagePdf() },
      { key: "B", pdf: await onePagePdf() },
    ];
    const invoices = [
      { key: "A", pdf: await onePagePdf() },
      { key: "B", pdf: await onePagePdf() },
    ];
    const plan = planInterleave(labels, invoices);
    const bytes = await combineInterleaved(plan);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(4);
  });
});

describe("convertTikTokBatch", () => {
  it("refuses with a typed error until a real extractor is built", async () => {
    await expect(convertTikTokBatch(new Uint8Array([1]), new Uint8Array([2]))).rejects.toMatchObject({
      name: "TikTokError",
      code: "tiktok_extraction_unavailable",
    });
  });

  it("runs end-to-end with an injected extractor", async () => {
    const extractor: TikTokExtractor = {
      extractLabels: async () => [
        { key: "A", pdf: await onePagePdf() },
        { key: "B", pdf: await onePagePdf() },
      ],
      extractInvoices: async () => [{ key: "A", pdf: await onePagePdf() }],
    };
    const { bytes, plan } = await convertTikTokBatch(new Uint8Array([1]), new Uint8Array([2]), extractor);
    expect(plan.unmatchedLabels).toEqual(["B"]);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(3); // label A + invoice A + label B
  });

  it("fails when there are no labels", async () => {
    const extractor: TikTokExtractor = { extractLabels: async () => [], extractInvoices: async () => [] };
    try {
      await convertTikTokBatch(new Uint8Array([1]), new Uint8Array([2]), extractor);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(TikTokError);
      expect((error as TikTokError).code).toBe("tiktok_no_labels");
    }
  });

  it("exposes a gated default extractor", async () => {
    await expect(createTikTokExtractor().extractLabels(new Uint8Array())).rejects.toBeInstanceOf(TikTokError);
  });
});
