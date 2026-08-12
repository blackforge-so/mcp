import { describe, expect, it } from "vitest";
import {
  MAX_WIDGET_POINTS,
  announcesWidgetSupport,
  buildChartPayload,
  decimate,
  findMetric,
} from "../src/widget.js";
import type { CatalogResponse, SeriesPoint } from "../src/types.js";
import {
  familyMasks,
  segmentByFamily,
  splitForDash,
  type QualityBit,
} from "../widget/src/quality.js";

const UI = "io.modelcontextprotocol/ui";

function point(ts: number, value: number | null, quality?: number, qualityAll?: number): SeriesPoint {
  return {
    ts,
    value,
    ...(quality !== undefined ? { quality } : {}),
    ...(qualityAll !== undefined ? { qualityAll } : {}),
  };
}

// Diagnostics only. This MUST NOT gate the payload: the official reference
// host (`ext-apps/examples/basic-host`) announces nothing and still renders
// widgets, so gating on it produced an empty chart there. Proven by running it.
describe("announcesWidgetSupport", () => {
  it("is false for a host that announces nothing — which includes hosts that DO render", () => {
    expect(announcesWidgetSupport(undefined, undefined)).toBe(false);
    expect(announcesWidgetSupport({ tools: {} }, {})).toBe(false);
    expect(announcesWidgetSupport({ extensions: {} }, {})).toBe(false);
  });

  it("recognises the initialize-time extensions field (SEP-1724)", () => {
    expect(announcesWidgetSupport({ extensions: { [UI]: { mimeTypes: [] } } }, undefined)).toBe(true);
  });

  it("recognises the per-request clientCapabilities _meta (spec 2026-07-28)", () => {
    const meta = { "io.modelcontextprotocol/clientCapabilities": { extensions: { [UI]: {} } } };
    expect(announcesWidgetSupport(undefined, meta)).toBe(true);
  });

  it("ignores a different extension", () => {
    expect(announcesWidgetSupport({ extensions: { "io.modelcontextprotocol/tasks": {} } }, {})).toBe(
      false,
    );
  });
});

describe("decimate", () => {
  it("passes a short series through untouched and reports no decimation", () => {
    const points = [point(1000, 5, 2, 2), point(2000, 6)];
    const result = decimate(points);

    expect(result.decimated).toBeUndefined();
    expect(result.points).toEqual([{ t: 1000, v: 5, q: 2, qa: 2 }, { t: 2000, v: 6 }]);
  });

  it("omits the quality keys entirely when the API sent none", () => {
    // The API predates the quality rail for old rows; a null or a 0 would be a
    // claim we are not entitled to make.
    const [only] = decimate([point(1000, 5)]).points;
    expect(only).toEqual({ t: 1000, v: 5 });
    expect("q" in only).toBe(false);
    expect("qa" in only).toBe(false);
  });

  it("folds quality with OR and qualityAll with AND", () => {
    const points = [point(0, 1, 0b0010, 0b0010), point(1, 2, 0b0100, 0b0100)];
    const { points: folded } = decimate(points, 1);

    // OR: something was wrong somewhere in the group.
    expect(folded[0].q).toBe(0b0110);
    // AND: nothing was wrong throughout the whole group.
    expect(folded[0].qa).toBe(0b0000);
  });

  it("keeps the LAST non-null value in a group, like a coarser API interval", () => {
    const points = [point(0, 1), point(1, 2), point(2, null)];
    const { points: folded } = decimate(points, 1);
    expect(folded[0]).toMatchObject({ t: 0, v: 2 });
  });

  it("reports the factor and the original count when it thins", () => {
    const points = Array.from({ length: MAX_WIDGET_POINTS * 3 }, (_, i) => point(i, i));
    const result = decimate(points);

    expect(result.decimated).toEqual({ from: MAX_WIDGET_POINTS * 3, factor: 3 });
    expect(result.points.length).toBeLessThanOrEqual(MAX_WIDGET_POINTS);
  });
});

describe("buildChartPayload", () => {
  const catalog: CatalogResponse = {
    venues: [],
    metrics: [
      {
        key: "spreadMean",
        label: "Mean spread",
        family: "bookMicro",
        unit: "percent",
        quoteRelative: false,
        nullable: true,
        description: "",
        howToRead: "",
        minPlan: "free",
      },
    ],
  };

  const base = {
    exchange: "binance",
    symbol: "BTCUSDT",
    metric: "spreadMean",
    interval: "1h",
    points: [point(0, 1)],
    bits: [] as QualityBit[],
    columnsOmitted: [],
  };

  it("carries the catalog's label, unit and family", () => {
    const payload = buildChartPayload({ ...base, meta: findMetric(catalog, "spreadMean") });
    expect(payload).toMatchObject({ label: "Mean spread", unit: "percent", family: "bookMicro" });
  });

  it("degrades to the metric key when the catalog was unreachable", () => {
    // Nothing is dotted in that case, because familyMasks with no family
    // returns zero masks — which is the safe direction.
    const payload = buildChartPayload({ ...base, meta: undefined });
    expect(payload).toMatchObject({ label: "spreadMean", unit: "count" });
    expect(payload.family).toBeUndefined();
  });
});

// ── the vendored quality rule ────────────────────────────────────────────────
// `widget/src/quality.ts` is a copy of the dashboard module. These lock the two
// behaviours that make the copy load-bearing, so a careless edit fails here
// rather than on a customer's chart.

describe("vendored quality segmentation", () => {
  const bits: QualityBit[] = [
    { bit: 1, mask: 2, name: "BOOK_DESYNCED", contaminates: ["bookMicro"] },
    { bit: 2, mask: 4, name: "EVENTS_LOST", contaminates: ["tradeFlow"] },
    { bit: 15, mask: 32768, name: "QUALITY_UNKNOWN", contaminates: ["bookMicro"], meaning: "notAssessed" },
  ];

  it("narrows flags to the metric's own family", () => {
    // A trade-flow flag must never dot a book-micro series.
    expect(familyMasks(bits, "bookMicro").flagged).toBe(2);
    expect(familyMasks(bits, "tradeFlow").flagged).toBe(4);
  });

  it("splits QUALITY_UNKNOWN out of the flagged mask by its `meaning`", () => {
    const masks = familyMasks(bits, "bookMicro");
    expect(masks.unassessed).toBe(32768);
    expect(masks.flagged & 32768).toBe(0);
  });

  it("reads unassessed as its own state, never as flagged", () => {
    const masks = familyMasks(bits, "bookMicro");
    const seg = segmentByFamily([32768, 2, 0], [0, 0, 0], masks);

    expect(seg.stateAt).toEqual(["unassessed", "flagged", "clean"]);
    expect(seg.flaggedBucketCount).toBe(1);
    expect(seg.unassessedBucketCount).toBe(1);
  });

  it("reads a missing mask as clean — no claim was made", () => {
    const masks = familyMasks(bits, "bookMicro");
    expect(segmentByFamily([null, null], [null, null], masks).stateAt).toEqual(["clean", "clean"]);
  });

  it("duplicates the boundary bucket into BOTH twins so the seam has no hole", () => {
    // uPlot extends each gap outward to the neighbouring non-null sample, so
    // omitting the boundary leaves a visible hole at every transition.
    // Bucket 1 ends the solid run and starts the dotted one, so it is the
    // boundary and must appear in both arrays.
    const split = splitForDash([1, 2, 3, 4], ["clean", "clean", "flagged", "flagged"]);

    expect(split.solid).toEqual([1, 2, null, null]);
    expect(split.dotted).toEqual([null, 2, 3, 4]);
  });

  it("leaves a bucket with no value null in BOTH twins", () => {
    const split = splitForDash([1, null, 3], ["clean", "clean", "clean"]);
    expect(split.solid[1]).toBeNull();
    expect(split.dotted[1]).toBeNull();
  });

  it("absorbs a two-bucket clean island between flagged runs into the dotted twin", () => {
    // Drawing it solid would let the dotted twin connect straight across, and
    // the two twins would paint the same stretch twice.
    const split = splitForDash([1, 2, 3, 4], ["flagged", "clean", "clean", "flagged"]);
    expect(split.solid.every((v) => v === null)).toBe(true);
  });
});
