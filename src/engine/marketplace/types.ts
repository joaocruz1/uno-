import type { OutputSize } from "../types";

/** Marketplaces the lote pipeline can convert. Grows one entry per template. */
export type Marketplace = "mercado-livre";

/** "12/28" on the top of each label, continued from the previous lote. */
export type LabelNumbering = {
  /** Optional lote prefix, e.g. "C" → "C12". Up to three A–Z letters. */
  letter?: string;
  /** 1-based number of the first label in this lote. */
  start: number;
  /** Append "/total" after the number (total = number of labels produced). */
  showTotal: boolean;
};

export type MarketplaceBatchOptions = {
  /** Output label size; defaults to 100 × 150 mm. */
  outputSize?: OutputSize;
  /** When present, each label is numbered in sequence. */
  numbering?: LabelNumbering;
  /** Hard ceiling on orders per file (mirrors the per-plan batch limit). */
  maxOrders?: number;
};

/** One order's result inside a lote. A failure here does not fail the lote. */
export type OrderOutcome =
  | { index: number; ok: true }
  | { index: number; ok: false; errorCode: string; errorMessage: string };

export type MarketplaceBatchResult = {
  marketplace: Marketplace;
  /** Combined PDF: one label page per succeeded order, in output order. */
  bytes: Uint8Array;
  /** Orders found in the input. */
  orderCount: number;
  succeeded: number;
  failed: number;
  outcomes: OrderOutcome[];
};
