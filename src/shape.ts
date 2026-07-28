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
  for (let i = 0; i < 16; i += 1) {
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

/**
 * A short sentence the model can act on. A bare mask like 6 is meaningless to a
 * reader that never fetched the decode table, so the note spells the situation
 * out. Returns undefined for a clean row so the key costs no tokens.
 */
export function qualityNote(quality: QualityAssessment | undefined): string | undefined {
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
    parts.push(
      "Call blackforge_catalog and read the `bits` table on the qualityFlags metric for what each flag means.",
    );
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
  return { ...data, metricCount: data.metrics.length };
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
