import { concatPdfs } from "./pdf";

/**
 * TikTok Shop ships the shipping-label/packing-slip PDF and the NF-e as two
 * separate files; they have to be reordered so each label is immediately
 * followed by its own invoice before printing (plan, Fase 3). The match key is
 * the package id / tracking number carried on both documents.
 *
 * Two layers, split on purpose (same posture as the Shopee reader):
 *  - the key normalization and the interleave planner below are independent of
 *    the PDF layout, so they are built and tested now;
 *  - splitting each PDF into per-order units and reading the tracking key off
 *    them is layout-specific (A6/A5, 1 or 2 pages per label by seller config),
 *    so it stays behind {@link TikTokExtractor} until a real sample pins it.
 */

export type TikTokErrorCode = "tiktok_no_labels" | "tiktok_extraction_unavailable";

const SAFE_MESSAGES: Record<TikTokErrorCode, string> = {
  tiktok_no_labels: "Nenhuma etiqueta foi encontrada no arquivo do TikTok.",
  tiktok_extraction_unavailable: "A leitura dos PDFs do TikTok ainda não está disponível.",
};

export class TikTokError extends Error {
  constructor(
    readonly code: TikTokErrorCode,
    message?: string,
  ) {
    super(message ?? SAFE_MESSAGES[code]);
    this.name = "TikTokError";
  }
}

/** One shipping label (already split to its own PDF) and its match key. */
export type LabelUnit = { key: string; pdf: Uint8Array };
/** One NF-e (its own PDF) and the key that ties it to a label. */
export type InvoiceUnit = { key: string; pdf: Uint8Array };

export type InterleaveEntry = { kind: "label" | "invoice"; key: string; pdf: Uint8Array };
export type InterleavePlan = {
  /** Labels in their original order, each followed by its matched invoice. */
  ordered: InterleaveEntry[];
  /** Normalized keys of labels that had no invoice (still printed, flagged). */
  unmatchedLabels: string[];
  /** Normalized keys of invoices that matched no label. */
  unmatchedInvoices: string[];
};

/** Package id / tracking numbers differ only by spacing or separators between
 * the two documents; normalize both sides before matching. */
export function normalizeTrackingKey(raw: string): string {
  return raw.replace(/[\s\-_.]/g, "").toUpperCase();
}

/**
 * Pairs each label with its invoice by normalized key and returns the print
 * order (label, its invoice, next label, …). A label keeps its place even
 * without an invoice; leftover invoices are reported, never silently dropped.
 * When several invoices share a key they are consumed in input order.
 */
export function planInterleave(labels: readonly LabelUnit[], invoices: readonly InvoiceUnit[]): InterleavePlan {
  const invoicesByKey = new Map<string, InvoiceUnit[]>();
  for (const invoice of invoices) {
    const key = normalizeTrackingKey(invoice.key);
    const list = invoicesByKey.get(key);
    if (list) list.push(invoice);
    else invoicesByKey.set(key, [invoice]);
  }

  const ordered: InterleaveEntry[] = [];
  const unmatchedLabels: string[] = [];
  for (const label of labels) {
    const key = normalizeTrackingKey(label.key);
    ordered.push({ kind: "label", key, pdf: label.pdf });
    const matched = invoicesByKey.get(key);
    if (matched && matched.length > 0) {
      ordered.push({ kind: "invoice", key, pdf: matched.shift()!.pdf });
    } else {
      unmatchedLabels.push(key);
    }
  }

  const unmatchedInvoices: string[] = [];
  for (const [key, list] of invoicesByKey) for (let i = 0; i < list.length; i += 1) unmatchedInvoices.push(key);

  return { ordered, unmatchedLabels, unmatchedInvoices };
}

/** Concatenates the planned order into one print-ready PDF. */
export function combineInterleaved(plan: InterleavePlan): Promise<Uint8Array> {
  return concatPdfs(plan.ordered.map((entry) => entry.pdf));
}

/**
 * Splits the TikTok shipping-label PDF into per-order labels and the NF-e PDF
 * into per-order invoices, reading the tracking key off each. Layout-specific
 * (A6/A5, 1 or 2 pages per label by seller config), so no reader is bound until
 * a real sample pins it — the match/interleave above is already complete.
 */
export interface TikTokExtractor {
  extractLabels(bytes: Uint8Array): Promise<LabelUnit[]>;
  extractInvoices(bytes: Uint8Array): Promise<InvoiceUnit[]>;
}

/** No extractor is bound until a real TikTok sample pins the layout; refuses
 * with a typed error rather than guessing. */
export function createTikTokExtractor(): TikTokExtractor {
  const refuse = async (): Promise<never> => {
    throw new TikTokError(
      "tiktok_extraction_unavailable",
      "A leitura dos PDFs do TikTok (etiqueta e NF-e) depende de uma amostra real para fixar o layout; o casamento NF-e↔etiqueta e a intercalação já estão prontos.",
    );
  };
  return { extractLabels: refuse, extractInvoices: refuse };
}

/**
 * End-to-end TikTok lote: extract both PDFs, pair them, and combine into one
 * print-ready PDF where each label is followed by its NF-e. Wired to the gated
 * extractor by default, so it refuses cleanly until the reader is built; the
 * ordering it depends on is covered by tests today.
 */
export async function convertTikTokBatch(
  labelsPdf: Uint8Array,
  invoicesPdf: Uint8Array,
  extractor: TikTokExtractor = createTikTokExtractor(),
): Promise<{ bytes: Uint8Array; plan: InterleavePlan }> {
  const [labels, invoices] = await Promise.all([extractor.extractLabels(labelsPdf), extractor.extractInvoices(invoicesPdf)]);
  if (labels.length === 0) throw new TikTokError("tiktok_no_labels");
  const plan = planInterleave(labels, invoices);
  return { bytes: await combineInterleaved(plan), plan };
}
