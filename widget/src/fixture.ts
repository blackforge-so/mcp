// A development fixture, for looking at the widget without an MCP host.
//
// Reached only via `?fixture` under `vite dev`, and guarded by
// `import.meta.env.DEV` at the call site so esbuild drops this module from the
// production bundle entirely. `npm test` asserts the marker below is absent
// from `dist/widget/chart.html`, so the guard cannot silently stop working.

export const FIXTURE_MARKER = "__blackforge_dev_fixture__";

/**
 * One series covering every state the chart must draw (288 buckets: a day at
 * `5m`, the default, or nearly five hours at `1m` via `?fixture=1m`):
 * a clean run, a flagged run, a gap with no rows, an unassessed run (the
 * pre-quality-rail archive), and a two-bucket clean island between two flagged
 * runs — the case `splitForDash` has a special rule for.
 */
export function devFixture(interval: "1m" | "5m" = "5m") {
  const BOOK_DESYNCED = 2;
  const QUALITY_UNKNOWN = 32768;
  const start = Date.UTC(2026, 6, 1);
  const count = 288;

  const points = Array.from({ length: count }, (_, i) => {
    const t = start + i * (interval === "1m" ? 1 : 5) * 60 * 1000;
    // A wandering spread, in percent, with a visible excursion under the flags.
    const base = 0.04 + Math.sin(i / 18) * 0.012 + Math.sin(i / 5) * 0.004;
    const v = i >= 96 && i < 132 ? base + 0.03 : base;

    if (i >= 40 && i < 52) return { t, v: null }; // no rows at all
    if (i < 30) return { t, v, q: QUALITY_UNKNOWN, qa: QUALITY_UNKNOWN };
    if (i >= 96 && i < 132) return { t, v, q: BOOK_DESYNCED, qa: i < 120 ? BOOK_DESYNCED : 0 };
    if (i === 200 || i === 203) return { t, v, q: BOOK_DESYNCED, qa: 0 }; // island case
    return { t, v, q: 0, qa: 0 };
  });

  return {
    v: 1 as const,
    exchange: "binance",
    symbol: "BTCUSDT",
    metric: "spreadMean",
    interval,
    label: "Mean spread",
    unit: "percent",
    family: "bookMicro",
    points,
    bits: [
      {
        bit: 1,
        mask: BOOK_DESYNCED,
        name: "BOOK_DESYNCED",
        description: "The order book lost sync with the venue.",
        contaminates: ["bookMicro", "bookWalls", "orderLadders"],
      },
      {
        bit: 11,
        mask: 2048,
        name: "EVENTS_LOST",
        description: "Book updates were dropped.",
        contaminates: ["tradeFlow"],
      },
      {
        bit: 15,
        mask: QUALITY_UNKNOWN,
        name: "QUALITY_UNKNOWN",
        description: "No quality information exists for this row.",
        contaminates: ["bookMicro"],
        meaning: "notAssessed",
      },
    ],
    columnsOmitted: [],
  };
}
