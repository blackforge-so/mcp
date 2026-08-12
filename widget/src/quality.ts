// Quality segmentation for the widget's chart.
//
// ── ORIGIN ───────────────────────────────────────────────────────────────────
// This is a VENDORED SUBSET of `dashboard/src/components/charts/quality-segments.utils.ts`.
// It is a deliberate copy, not an accident, and the reasons are worth stating
// because the next person to read this will want to delete one of them:
//
//   * `mcp/` and `dashboard/` are separate git repos with separate release
//     cycles. A shared package would be an eighth repo plus a publish
//     dependency between two things that ship on different days.
//   * `@blackforge-so/mcp` runs on `@modelcontextprotocol/sdk` + `zod` and
//     nothing else. The dashboard module is framework-free, but the file it
//     lives beside imports React and the dashboard's own zod schemas.
//
// What is copied is the ALGORITHM (which buckets get the flagged treatment,
// and how a dash is split across two uPlot series). What is emphatically NOT
// copied is the BIT TABLE — masks, names, and which families each bit
// contaminates are SERVED by `/v1/catalog` and arrive in the payload. The
// collector and the API both carry the standing note that two copies of that
// table is the most that may ever exist, and this file keeps that true.
//
// `npm run widget:check` diffs the exported function bodies against the
// dashboard copy and fails when they drift.

/** The served decode table, seen through the loosest lens that still works. */
export interface QualityBit {
  bit?: number;
  mask?: number;
  name?: string;
  description?: string;
  contaminates?: string[];
  /** Only `QUALITY_UNKNOWN` carries this: absence of a measurement, not a defect. */
  meaning?: string;
}

/**
 * What a single bucket says about the metric family being drawn.
 *
 * `unassessed` is deliberately NOT a defect state. `QUALITY_UNKNOWN` is the
 * ClickHouse column default, so every row written before the quality rail
 * shipped carries it, retention is infinite, and it will therefore be on
 * screen for years. It means "we did not measure quality for this period",
 * which is a different claim from "this data is unreliable".
 */
export type QualityState = "clean" | "unassessed" | "flagged";

export interface QualitySegmentation {
  /** Per-index state, same length as the input. */
  stateAt: QualityState[];
  /** Masks of the contaminating bits actually set at each index, for the readout. */
  flaggedMaskAt: number[];
  /** True where the contamination held for EVERY native window in the bucket. */
  sustainedAt: boolean[];
  flaggedBucketCount: number;
  unassessedBucketCount: number;
  hasFlagged: boolean;
  hasUnassessed: boolean;
}

export interface FamilyMasks {
  flagged: number;
  unassessed: number;
}

const EMPTY_MASKS: FamilyMasks = { flagged: 0, unassessed: 0 };

function maskOf(bit: QualityBit): number | undefined {
  if (typeof bit.mask === "number") return bit.mask;
  if (typeof bit.bit === "number") return 1 << bit.bit;
  return undefined;
}

/**
 * Fold the served bit table into two integer masks for one family, so the
 * per-point test is a single bitwise AND rather than a scan over 16 rows.
 *
 * `QUALITY_UNKNOWN` contaminates all families, so it would swamp the flagged
 * mask for every metric. It is split out by its `meaning` field instead — the
 * API sets `meaning: 'notAssessed'` on that bit and no other, precisely so a
 * client can tell the two apart.
 */
export function familyMasks(
  bits: readonly QualityBit[] | undefined,
  family: string | undefined,
): FamilyMasks {
  if (!bits || bits.length === 0 || !family) return EMPTY_MASKS;

  let flagged = 0;
  let unassessed = 0;
  for (const bit of bits) {
    const mask = maskOf(bit);
    if (mask === undefined) continue;
    if (bit.meaning === "notAssessed") {
      unassessed |= mask;
    } else if (bit.contaminates?.includes(family)) {
      flagged |= mask;
    }
  }
  return { flagged, unassessed };
}

/**
 * Classify one bucket.
 *
 * A row that is both flagged and unassessed reports as `flagged`: at a coarse
 * granularity the OR can merge rows written before the rail with rows written
 * after it, and a measured defect is a stronger claim than the absence of a
 * measurement.
 *
 * A `null` mask means no quality claim is available — either the bucket has no
 * row, or the API predates the quality rail. Both read as `clean` so nothing is
 * dotted on a claim that was never made.
 */
function stateFor(mask: number | null, masks: FamilyMasks): QualityState {
  if (mask == null) return "clean";
  if ((mask & masks.flagged) !== 0) return "flagged";
  if ((mask & masks.unassessed) !== 0) return "unassessed";
  return "clean";
}

export function segmentByFamily(
  quality: readonly (number | null)[],
  qualityAll: readonly (number | null)[],
  masks: FamilyMasks,
): QualitySegmentation {
  const length = quality.length;
  const stateAt: QualityState[] = new Array(length);
  const flaggedMaskAt: number[] = new Array(length);
  const sustainedAt: boolean[] = new Array(length);

  let flaggedBucketCount = 0;
  let unassessedBucketCount = 0;

  for (let i = 0; i < length; i += 1) {
    const mask = quality[i] ?? null;
    const state = stateFor(mask, masks);
    stateAt[i] = state;
    flaggedMaskAt[i] = mask == null ? 0 : mask & masks.flagged;
    sustainedAt[i] = ((qualityAll[i] ?? 0) & masks.flagged) !== 0;

    if (state === "flagged") flaggedBucketCount += 1;
    else if (state === "unassessed") unassessedBucketCount += 1;
  }

  return {
    stateAt,
    flaggedMaskAt,
    sustainedAt,
    flaggedBucketCount,
    unassessedBucketCount,
    hasFlagged: flaggedBucketCount > 0,
    hasUnassessed: unassessedBucketCount > 0,
  };
}

/**
 * Which states are drawn with the dotted treatment.
 *
 * Only `flagged`. `unassessed` stays solid and is reported in words instead —
 * dotting it would paint the entire pre-rail archive as defective on day one,
 * a worse honesty failure than the one this feature exists to fix.
 */
export function isDotted(state: QualityState): boolean {
  return state === "flagged";
}

export interface DashSplit {
  solid: (number | null)[];
  dotted: (number | null)[];
}

/**
 * Split one value array into two complementary arrays, one per uPlot twin.
 *
 * uPlot cannot vary a dash within a series — `setCtxStyle` reads `series.dash`
 * once per series per frame — so a single logical series is drawn as two
 * overlaid series with complementary null gaps.
 *
 * Two rules make the seam invisible, both established by driving uPlot's real
 * `paths.linear()` builder:
 *
 *  1. **A boundary bucket appears in BOTH arrays.** uPlot's `findGaps` runs
 *     with `alignGaps: 0`, which extends each gap outward to the neighbouring
 *     non-null sample. Duplicating the boundary makes the two clip regions
 *     abut exactly; omitting it leaves a visible hole at every transition.
 *  2. **A bucket with no value is null in BOTH arrays**, so the line breaks
 *     there exactly as it does with no quality data at all.
 */
export function splitForDash(
  draw: readonly (number | null)[],
  stateAt: readonly QualityState[],
): DashSplit {
  const length = draw.length;
  const solid: (number | null)[] = new Array(length).fill(null);
  const dotted: (number | null)[] = new Array(length).fill(null);

  const present: boolean[] = new Array(length);
  const dot: boolean[] = new Array(length);
  for (let i = 0; i < length; i += 1) {
    present[i] = draw[i] != null;
    dot[i] = present[i] && isDotted(stateAt[i]);
  }

  // Assign each SEGMENT, then let a bucket join a twin when it is an endpoint
  // of a segment that twin draws. Reasoning in segments rather than buckets is
  // what makes the endpoint rule exact.
  const segmentDotted: boolean[] = new Array(Math.max(0, length - 1)).fill(false);
  for (let s = 0; s + 1 < length; s += 1) {
    if (!present[s] || !present[s + 1]) continue;

    if (dot[s] || dot[s + 1]) {
      segmentDotted[s] = true;
      continue;
    }

    // A clean segment whose BOTH endpoints already sit in the dotted twin —
    // a two-bucket clean island between two flagged runs — cannot be drawn
    // solid: the dotted twin would connect straight across it and the two
    // twins would paint the same stretch twice. Absorb it into the dotted
    // side. This over-labels one segment as unreliable, which is the safe
    // direction: it never claims data is clean when it is not.
    const leftDotted = s > 0 && present[s - 1] && dot[s - 1];
    const rightDotted = s + 2 < length && present[s + 2] && dot[s + 2];
    if (leftDotted && rightDotted) segmentDotted[s] = true;
  }

  for (let i = 0; i < length; i += 1) {
    if (!present[i]) continue;
    const value = draw[i] as number;

    const leftDrawable = i > 0 && present[i - 1];
    const rightDrawable = i + 1 < length && present[i + 1];

    const inDotted =
      (leftDrawable && segmentDotted[i - 1]) || (rightDrawable && segmentDotted[i]);
    const inSolid =
      (leftDrawable && !segmentDotted[i - 1]) || (rightDrawable && !segmentDotted[i]);

    if (inDotted) dotted[i] = value;
    if (inSolid) solid[i] = value;

    // An isolated bucket has no segment to belong to. Place it by its own state.
    if (!inDotted && !inSolid) {
      if (dot[i]) dotted[i] = value;
      else solid[i] = value;
    }
  }

  return { solid, dotted };
}

export interface QualitySummary {
  flaggedCount: number;
  unassessedCount: number;
  totalBuckets: number;
  sustained: boolean;
  flagNames: string[];
}

export function summarize(
  segmentation: QualitySegmentation,
  bits: readonly QualityBit[],
): QualitySummary | null {
  if (!segmentation.hasFlagged && !segmentation.hasUnassessed) return null;

  let union = 0;
  let sustainedAll = segmentation.hasFlagged;
  for (let i = 0; i < segmentation.flaggedMaskAt.length; i += 1) {
    const mask = segmentation.flaggedMaskAt[i];
    if (mask === 0) continue;
    union |= mask;
    if (!segmentation.sustainedAt[i]) sustainedAll = false;
  }

  return {
    flaggedCount: segmentation.flaggedBucketCount,
    unassessedCount: segmentation.unassessedBucketCount,
    totalBuckets: segmentation.stateAt.length,
    sustained: sustainedAll,
    flagNames: bits
      .filter((bit) => {
        const mask = maskOf(bit);
        return mask !== undefined && (union & mask) !== 0;
      })
      .sort((a, b) => (a.bit ?? 0) - (b.bit ?? 0))
      .map((bit) => bit.name ?? "unnamed"),
  };
}

/**
 * The legend chip's label.
 *
 * "flagged" rather than "unreliable" or "provisional", deliberately.
 * "Unreliable" asserts a conclusion the product refuses to draw. "Provisional"
 * is worse: it promises the value will be revised later, and it will not.
 * "Flagged" says only what BlackForge did, which is attach a label.
 *
 * The denominator is load-bearing. "12 flagged" reads as an incident report;
 * "12 of 288" is self-scaling and visibly small.
 */
export function chipLabel(flaggedCount: number, totalBuckets: number): string {
  return `${flaggedCount} of ${totalBuckets} flagged`;
}

/** Kept separate from the flagged count and never merged into it. */
export function unknownChipLabel(unassessedCount: number, totalBuckets: number): string {
  return unassessedCount >= totalBuckets
    ? "Quality not recorded for this range"
    : `${unassessedCount} of ${totalBuckets} unchecked`;
}
