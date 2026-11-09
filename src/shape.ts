// Payload shaping for the MCP tools, plus the quality-flag helpers they use.
//
// Two rules govern everything in here:
//
//  1. ADDITIVE BY DEFAULT. Each shaper SPREADS the raw /v1 payload and only ADDS
//     derived fields. An earlier version listed keys explicitly, which silently
//     dropped any new sibling key the API started sending before the model ever
//     saw it. Never reintroduce an allowlist.
//  2. QUALITY IS OPTIONAL. The API does not serve `quality` yet. When it is
//     absent every payload here must be byte-identical to what it was before
//     the field existed — no key, no null, no default.

import type {
  BlackForgeMeta,
  CatalogResponse,
  FuturesLatestResponse,
  FuturesLiquidationsResponse,
  FuturesTopResponse,
  LatestResponse,
  QualityAssessment,
  QualityBit,
  SeriesResponse,
} from "./types.js";

/**
 * The ClickHouse column DEFAULT: "this row predates the quality rail", NOT
 * "this row is bad". The whole historical archive reads this value, so it is
 * reported as neutral/unassessed and never as a warning. This is a single
 * contract sentinel, not a decode table.
 */
export const QUALITY_UNKNOWN = 32768;

/** Everything except the unknown sentinel bit. */
const REAL_FLAG_MASK = ~QUALITY_UNKNOWN;

/** True when the mask carries an actual quality flag (unknown alone does not). */
export function isFlagged(mask: number): boolean {
  return (mask & REAL_FLAG_MASK) !== 0;
}

/** True when the row was simply never assessed. */
export function isUnassessed(mask: number): boolean {
  return mask === QUALITY_UNKNOWN;
}

/**
 * Decode a mask into flag names using the catalog's `bits` table. Bits with no
 * entry in the table fall back to their raw mask — we never guess a name and
 * never carry a local copy of the table. The unknown sentinel bit is skipped:
 * callers report it separately, in neutral wording.
 */
export function decodeMask(mask: number, bits: QualityBit[]): string[] {
  const byMask = new Map<number, string>();
  for (const b of bits) {
    const m = b.mask ?? (b.bit !== undefined ? 1 << b.bit : undefined);
    const name = b.name ?? b.label;
    if (m !== undefined && name) byMask.set(m, name);
  }
  const out: string[] = [];
  // Bits 0-30: the column is UInt32 and bit 31 is never used (a JS shift would go negative).
  // The table grew past 16 bits (16 NEAR_DEPTH_PARTIAL, 17 BOOK_EMPTY_AT_VENUE, 18
  // TRADES_BACKFILLED); a fixed 16 silently dropped every bit above 15.
  for (let i = 0; i < 31; i += 1) {
    const bitMask = 1 << i;
    if (bitMask === QUALITY_UNKNOWN) continue;
    if ((mask & bitMask) === 0) continue;
    out.push(byMask.get(bitMask) ?? `mask ${bitMask}`);
  }
  return out;
}

/** Pull the quality decode table off a catalog payload, if it is there. */
export function bitsFromCatalog(catalog: CatalogResponse): QualityBit[] {
  return catalog.metrics.find((m) => m.key === "qualityFlags")?.bits ?? [];
}

function joinWords(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Where the spot decode table lives, for the note on a flag the server did not decode. */
const SPOT_TABLE_HINT =
  "Call blackforge_catalog and read the `bits` table on the qualityFlags metric for what each flag means.";

/** Where the futures decode table lives. A field, not an instruction. */
export const FUTURES_TABLE_HINT =
  "The futures `qualityBits` table in blackforge_catalog says what each flag means.";

/**
 * Pull the FUTURES decode table off a catalog payload. Never the spot table:
 * the same bit number means a different thing on a futures row.
 */
export function futuresBitsFromCatalog(catalog: CatalogResponse): QualityBit[] {
  return catalog.futures?.qualityBits ?? [];
}

/**
 * A short sentence the model can act on. A bare mask like 6 is meaningless to a
 * reader that never fetched the decode table, so the note spells the situation
 * out. Returns undefined for a clean row so the key costs no tokens.
 * `tableHint` names where the decode table lives (spot by default).
 */
export function qualityNote(
  quality: QualityAssessment | undefined,
  tableHint: string = SPOT_TABLE_HINT,
): string | undefined {
  if (!quality) return undefined;
  const raw = quality.raw;
  if (typeof raw !== "number" || raw === 0) return undefined;

  if (isUnassessed(raw)) {
    return (
      "This row predates the quality rail, so its measurement quality was not assessed. " +
      "Treat it as unknown, not as bad."
    );
  }

  const names = quality.flags?.length ? quality.flags : [`mask ${raw}`];
  const affected = quality.contaminates ?? [];
  const parts = [`Quality flags on this window: ${names.join(", ")}.`];
  if (affected.length) {
    parts.push(
      `That flags the ${joinWords(affected)} figures for this window; ` +
        "every other column in the row is unaffected.",
    );
  } else {
    parts.push(tableHint);
  }
  return parts.join(" ");
}

export interface QualitySummary {
  flaggedBuckets: number;
  of: number;
  flags: Record<string, number>;
  /** Only present when some buckets predate the quality rail. */
  unassessedBuckets?: number;
}

/**
 * Aggregate the per-point quality integers into one small object. Per-point
 * quality is never emitted to the model — a 50,000-point response with a field
 * per point is a token bomb — so this is the only quality the series tool
 * carries. Returns undefined when no bucket is flagged.
 */
export function summarizeQuality(
  points: Array<{ quality?: number }>,
  bits: QualityBit[],
): QualitySummary | undefined {
  let flaggedBuckets = 0;
  let unassessedBuckets = 0;
  const flags: Record<string, number> = {};
  for (const p of points) {
    const mask = p.quality;
    if (typeof mask !== "number" || mask === 0) continue;
    if (isUnassessed(mask)) {
      unassessedBuckets += 1;
      continue;
    }
    if (!isFlagged(mask)) continue;
    flaggedBuckets += 1;
    for (const name of decodeMask(mask, bits)) {
      flags[name] = (flags[name] ?? 0) + 1;
    }
  }
  if (!flaggedBuckets) return undefined;
  return {
    flaggedBuckets,
    of: points.length,
    flags,
    ...(unassessedBuckets ? { unassessedBuckets } : {}),
  };
}

/** True when at least one point carries a real flag — i.e. worth fetching the table. */
export function anyFlagged(points: Array<{ quality?: number }>): boolean {
  return points.some((p) => typeof p.quality === "number" && isFlagged(p.quality));
}

// --- payload shapers --------------------------------------------------------

export function shapeCatalog(data: CatalogResponse): unknown {
  // Sold futures columns only: an internal one measures the recorder and is in no plan.
  const futuresMetrics = data.futures?.metrics;
  const futures = Array.isArray(futuresMetrics)
    ? { futuresMetricCount: futuresMetrics.filter((m) => !m.internal).length }
    : {};
  return { ...data, metricCount: data.metrics.length, ...futures };
}

export function shapeLatest(
  data: LatestResponse,
  meta: BlackForgeMeta,
  ctx: { exchange: string; symbol: string },
): unknown {
  const note = qualityNote(data.quality);
  // ctx first so the API's own echo of these keys wins if it ever sends them.
  const base = { exchange: ctx.exchange, symbol: ctx.symbol };
  return {
    ...base,
    ...data,
    tsIso: data.ts ? new Date(data.ts).toISOString() : null,
    valueCount: Object.keys(data.values).length,
    ...(note ? { qualityNote: note } : {}),
    rowsRemaining: meta.rowsRemaining,
    columnsOmitted: meta.columnsOmitted ?? [],
  };
}

export function shapeSeries(
  data: SeriesResponse,
  meta: BlackForgeMeta,
  ctx: { exchange: string; symbol: string; metric: string; interval: string },
  summary?: QualitySummary,
): unknown {
  const base = {
    exchange: ctx.exchange,
    symbol: ctx.symbol,
    metric: ctx.metric,
    interval: ctx.interval,
  };
  return {
    ...base,
    ...data,
    // Points as they came, minus the two per-point quality integers: those are
    // aggregated into qualitySummary instead of repeated 50,000 times.
    points: data.points.map(({ quality: _q, qualityAll: _qa, ...rest }) => rest),
    pointCount: data.points.length,
    ...(summary ? { qualitySummary: summary } : {}),
    columnsOmitted: meta.columnsOmitted ?? [],
  };
}

// --- futures shapers (same additive rule) -------------------------------------

export function shapeFuturesLatest(
  data: FuturesLatestResponse,
  meta: BlackForgeMeta,
  ctx: { exchange: string; symbol: string },
): unknown {
  const note = qualityNote(data.quality, FUTURES_TABLE_HINT);
  const base = { exchange: ctx.exchange, symbol: ctx.symbol };
  return {
    ...base,
    ...data,
    tsIso: data.ts ? new Date(data.ts).toISOString() : null,
    valueCount: Object.keys(data.values).length,
    ...(note ? { qualityNote: note } : {}),
    rowsRemaining: meta.rowsRemaining,
    columnsOmitted: meta.columnsOmitted ?? [],
  };
}

export function shapeFuturesTop(data: FuturesTopResponse, meta: BlackForgeMeta): unknown {
  return {
    ...data,
    tsIso: data.ts ? new Date(data.ts).toISOString() : null,
    rowCount: data.rows.length,
    rowsRemaining: meta.rowsRemaining,
    columnsOmitted: meta.columnsOmitted ?? [],
  };
}

/**
 * `lowerBound` is the catalog's word for a venue that throttles its public
 * liquidation feed. Which venues those are comes from the catalog, never a
 * local list; the note only names venues actually present in the result.
 */
export function liquidationFeedNote(
  events: Array<{ exchange: string }>,
  lowerBoundVenues: string[],
): string | undefined {
  const present = lowerBoundVenues.filter((venue) => events.some((e) => e.exchange === venue));
  if (!present.length) return undefined;
  const who = joinWords(present);
  return present.length === 1
    ? `${who} throttles its public liquidation feed, so in a cascade its events here are a lower bound.`
    : `${who} throttle their public liquidation feeds, so in a cascade their events here are a lower bound.`;
}

export function shapeFuturesLiquidations(
  data: FuturesLiquidationsResponse,
  meta: BlackForgeMeta,
  lowerBoundVenues: string[],
): unknown {
  const iso = (v: number | string) => (typeof v === "number" ? new Date(v).toISOString() : v);
  const note = liquidationFeedNote(data.events, lowerBoundVenues);
  return {
    ...data,
    fromIso: iso(data.from),
    toIso: iso(data.to),
    eventCount: data.events.length,
    ...(note ? { feedNote: note } : {}),
    rowsRemaining: meta.rowsRemaining,
  };
}
