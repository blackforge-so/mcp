// Customer-facing wording for the quality bits.
//
// VENDORED from `dashboard/src/components/charts/quality-copy.ts` — see the
// origin note in `quality.ts`.
//
// This is PRESENTATION, not taxonomy. The bits themselves — masks, which
// families each one calls into question — are served by the API and are never
// copied here. What lives here is only the sentence a reader sees, keyed by the
// served bit name, because the served descriptions are written for two
// audiences at once and one of them is a machine.
//
// `QUALITY_UNKNOWN` is the case that forces the split. The API serves "no
// quality information exists for this row", which is exactly right for an agent
// reading JSON and quite wrong on a chart: it reads as an accusation, and "row"
// is schema vocabulary for something the reader sees as a bucket.
//
// Any bit with no entry here falls back to the served `description`, so a bit
// added upstream tomorrow renders as less polished but still correct, never as
// nothing.

import type { QualityBit } from "./quality.js";

const REASONS: Record<string, string> = {
  BOOK_DESYNCED: "We lost sync with the venue book here and rebuilt it, so depth may be off.",
  BOOK_ONE_SIDED:
    "The venue quoted only one side of the book, so spread and depth are incomplete.",
  BOOK_CROSSED: "Best bid sat at or above best ask, so the spread reads as zero or negative.",
  BOOK_DEEP_STALE:
    "We hold more price levels than the venue keeps updating, so the deepest ones are frozen.",
  SYMBOL_DELISTED: "The venue had stopped listing this pair, so there was no live book.",
  PRICE_FROM_MID: "No trade printed here, so this price came from the middle of the book.",
  PRICE_FROM_LAST_TRADE: "No trade printed in this period, so the price is the last one that did.",
  PRICE_UNAVAILABLE: "No price could be established here, so the candle is empty.",
  QUOTE_RATE_SUSPECT:
    "The quote asset USD rate looked stale or implausible, so USD values may be off.",
  IDENTITY_CONFLICT: "This ticker matched more than one coin, so market cap and rank may be wrong.",
  DEPTH_BEYOND_COVERAGE: "The book we hold ran out before the widest band, so wide bands are partial.",
  EVENTS_LOST: "Some book updates were dropped, so churn and liquidity counts run low.",
  EVENTS_REATTRIBUTED: "Some book updates from a neighbouring period were counted here.",
  BOOK_EMPTY: "The book had no resting orders at all, so there was no depth to measure.",
  NOT_MEASURED: "Some columns in this period are placeholders rather than measurements.",
  QUALITY_UNKNOWN: "Collected before we started recording quality. Unchecked, not unreliable.",
};

/**
 * Bits that are always accompanied by a more specific one, and would otherwise
 * print a second sentence for the same event. An empty book and a crossed book
 * both force the collector to mark the book out of sync, so `BOOK_DESYNCED`
 * rides along with either.
 */
const SUPPRESSED_BY: Record<string, readonly string[]> = {
  BOOK_DESYNCED: ["BOOK_EMPTY", "BOOK_CROSSED", "SYMBOL_DELISTED"],
};

function maskOf(bit: QualityBit): number | undefined {
  if (typeof bit.mask === "number") return bit.mask;
  if (typeof bit.bit === "number") return 1 << bit.bit;
  return undefined;
}

/** The reason for one bit: our wording, else the served description. */
export function reasonFor(bit: QualityBit): string {
  const name = bit.name ?? "";
  return REASONS[name] ?? bit.description ?? name;
}

/**
 * The plain-English reasons a bucket's mask gives, in bit order, deduped.
 *
 * Only bits passed in are considered, so the caller decides which family's bits
 * are relevant — a book flag has no business appearing under a trade series.
 */
export function reasonsForMask(mask: number, bits: readonly QualityBit[]): string[] {
  const set = bits.filter((bit) => {
    const m = maskOf(bit);
    return m !== undefined && (mask & m) !== 0;
  });
  const setNames = new Set(set.map((bit) => bit.name ?? ""));

  return set
    .filter((bit) => !SUPPRESSED_BY[bit.name ?? ""]?.some((name) => setNames.has(name)))
    .sort((a, b) => (a.bit ?? 0) - (b.bit ?? 0))
    .map(reasonFor);
}

/**
 * How much of the period a reason covers.
 *
 * At coarse granularity the API's bitwise OR saturates — one bad five-minute
 * window flags a whole day — so the OR alone would say very little. The bitwise
 * AND is what separates a brief problem from a persistent one.
 */
export function coverageWord(sustained: boolean): string {
  return sustained ? "Throughout this period." : "For part of this period.";
}
