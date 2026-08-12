// The BlackForge series chart, as an MCP App.
//
// Runs inside the host's sandboxed iframe. It receives one `CallToolResult`
// from `blackforge_series` on `ui/notifications/tool-result` and draws it. It
// makes NO network calls of its own: everything it needs — points, the served
// quality bit table, the metric's unit and family — rides in `_meta` on that
// result, which is why the resource declares no `csp.connectDomains` and needs
// no CORS origin.
//
// It also calls no tools. `app.callServerTool` is available and would let the
// reader re-range the chart in place, but every such call spends the customer's
// row quota without them asking. That is a product decision, not a technical
// limit; see `mcp-widgets.docs.md`.

import { App, applyDocumentTheme, getDocumentTheme } from "@modelcontextprotocol/ext-apps";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { formatAxisValue, formatReadoutValue, formatTimestamp } from "./format.js";
import { coverageWord, reasonsForMask } from "./copy.js";
import {
  chipLabel,
  familyMasks,
  segmentByFamily,
  splitForDash,
  summarize,
  unknownChipLabel,
  type QualityBit,
  type QualitySegmentation,
} from "./quality.js";

const CHART_META_KEY = "so.blackforge/chart";

interface WidgetPoint {
  t: number;
  v: number | null;
  q?: number;
  qa?: number;
}

interface WidgetPayload {
  v: 1;
  exchange: string;
  symbol: string;
  metric: string;
  interval: string;
  label: string;
  unit: string;
  family?: string;
  points: WidgetPoint[];
  bits: QualityBit[];
  decimated?: { from: number; factor: number };
  columnsOmitted: string[];
}

// ── The provisional-data treatment ───────────────────────────────────────────
// Same token set as the dashboard, and the same one-sentence rule a reader can
// state: wherever the mark is fainter, that bucket is flagged; solid means
// final. These are TS constants rather than CSS custom properties because
// uPlot draws to a canvas, which cannot resolve `var()`.

/** Dash for a flagged stretch, in DEVICE pixels — chosen for the 2x case. */
const FLAGGED_DASH = [2, 3];

/**
 * Stroke width for a flagged stretch, against 1.5 for settled data.
 *
 * This is the load-bearing channel, not the dash. Canvas applies a dash along
 * ARC LENGTH, so a dense series inside a narrow card collapses the dash into a
 * merely lighter solid line. Width is evaluated per pixel column, so it reads
 * identically at 30 points and at the cap.
 */
const FLAGGED_WIDTH = 0.75;

/**
 * Opacity for a flagged stretch. A floor, not a free parameter: 0.8 puts the
 * greyest palette entry at exactly 3.00:1, the WCAG non-text contrast minimum.
 * Lower starts to read as "no data here", which is what a gap already means.
 */
const FLAGGED_ALPHA = 0.8;

const el = {
  root: byId("root"),
  title: byId("title"),
  subtitle: byId("subtitle"),
  chart: byId("chart"),
  readout: byId("readout"),
  chips: byId("chips"),
  reasons: byId("reasons"),
  footer: byId("footer"),
};

function byId(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

function themeVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

let plot: uPlot | undefined;
let current: WidgetPayload | undefined;
let segmentation: QualitySegmentation | undefined;

const app = new App({ name: "BlackForge series chart", version: "0.1.0" });

app.ontoolresult = (result) => {
  const payload = readPayload(result);
  if (!payload) {
    // A host that pushed a result without our `_meta` is not an error state —
    // the model already has the JSON. Say so plainly rather than showing an
    // empty frame.
    el.subtitle.textContent = "No chart data on this result.";
    return;
  }
  current = payload;
  render(payload);
};

app.onhostcontextchanged = (ctx) => {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (current) render(current);
};

// Development only. `import.meta.env.DEV` is a compile-time constant, so this
// whole branch — and the fixture module it imports — is dropped from the
// production bundle. A test asserts the marker is absent from the built file.
if (import.meta.env.DEV && new URLSearchParams(location.search).has("fixture")) {
  void import("./fixture.js").then(({ devFixture, FIXTURE_MARKER }) => {
    document.documentElement.dataset.fixture = FIXTURE_MARKER;
    current = devFixture() as WidgetPayload;
    render(current);
  });
} else {
  void app.connect().then(() => {
    const ctx = app.getHostContext();
    applyDocumentTheme(ctx?.theme ?? getDocumentTheme());
  });
}

/**
 * Pull our payload off the tool result.
 *
 * `_meta` is where the server puts it, deliberately — not `structuredContent`,
 * which core MCP treats as model-facing result data. Both are read here anyway,
 * so a future server that moves it costs the widget nothing.
 */
function readPayload(result: unknown): WidgetPayload | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const record = result as Record<string, unknown>;

  const candidates = [
    (record._meta as Record<string, unknown> | undefined)?.[CHART_META_KEY],
    (record.structuredContent as Record<string, unknown> | undefined)?.[CHART_META_KEY],
  ];

  for (const candidate of candidates) {
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as WidgetPayload).v === 1 &&
      Array.isArray((candidate as WidgetPayload).points)
    ) {
      return candidate as WidgetPayload;
    }
  }
  return undefined;
}

function render(payload: WidgetPayload): void {
  const { points, bits, family, unit, interval } = payload;

  el.title.textContent = `${payload.label} — ${payload.symbol} on ${payload.exchange}`;
  el.subtitle.textContent = `${points.length.toLocaleString("en-US")} buckets at ${interval}`;

  // The masks come from the SERVED table and are narrowed to this metric's
  // family, so a book flag never dots a trade series.
  const masks = familyMasks(bits, family);
  segmentation = segmentByFamily(
    points.map((p) => (typeof p.q === "number" ? p.q : null)),
    points.map((p) => (typeof p.qa === "number" ? p.qa : null)),
    masks,
  );

  renderChips(segmentation, bits);
  renderFooter(payload);
  drawPlot(payload, segmentation);
}

function renderChips(seg: QualitySegmentation, bits: QualityBit[]): void {
  el.chips.replaceChildren();
  el.reasons.replaceChildren();

  if (seg.hasFlagged) {
    el.chips.append(chip(chipLabel(seg.flaggedBucketCount, seg.stateAt.length), "flagged"));
  }
  if (seg.hasUnassessed) {
    el.chips.append(
      chip(unknownChipLabel(seg.unassessedBucketCount, seg.stateAt.length), "unchecked"),
    );
  }
  if (!seg.hasFlagged) return;

  // One sentence per distinct reason, with how much of the range it covered.
  const union = seg.flaggedMaskAt.reduce((acc, mask) => acc | mask, 0);
  const summary = summarize(seg, bits);
  for (const reason of reasonsForMask(union, bits)) {
    const line = document.createElement("li");
    line.textContent = `${reason} ${coverageWord(summary?.sustained ?? false)}`;
    el.reasons.append(line);
  }
}

function chip(text: string, kind: "flagged" | "unchecked"): HTMLElement {
  const node = document.createElement("span");
  node.className = `chip chip--${kind}`;
  node.textContent = text;
  return node;
}

function renderFooter(payload: WidgetPayload): void {
  const parts: string[] = [];
  if (payload.decimated) {
    parts.push(
      `Showing 1 of every ${payload.decimated.factor} buckets ` +
        `(${payload.decimated.from.toLocaleString("en-US")} in the full response). ` +
        `The tool result the model read carries every bucket.`,
    );
  }
  if (payload.columnsOmitted.length) {
    parts.push(`Withheld by plan: ${payload.columnsOmitted.join(", ")}.`);
  }
  parts.push("Measurements, not trade calls.");
  el.footer.textContent = parts.join(" ");
}

function drawPlot(payload: WidgetPayload, seg: QualitySegmentation): void {
  plot?.destroy();
  el.chart.replaceChildren();

  const xs = payload.points.map((p) => p.t / 1000);
  const values = payload.points.map((p) => p.v);

  // A series with nothing flagged stays WHOLE — one uPlot series, byte for byte
  // the chart it would have been before the quality rail existed. Only a series
  // that actually carries a flag pays for the twin.
  const split = seg.hasFlagged ? splitForDash(values, seg.stateAt) : undefined;
  const data = (split ? [xs, split.solid, split.dotted] : [xs, values]) as uPlot.AlignedData;

  // Resolved here, not in CSS: uPlot paints to a canvas, which cannot read
  // `var()`. This is also why `render()` re-runs on every host theme change —
  // the canvas has to be rebuilt to pick up new colours.
  const axisStroke = themeVar("--axis", "rgba(11, 28, 43, 0.45)");
  const grid = themeVar("--grid", "rgba(11, 28, 43, 0.10)");
  const stroke = themeVar("--stroke", "#205278");
  const font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";

  const base: uPlot.Series = {
    stroke,
    width: 1.5,
    spanGaps: false,
    points: { show: false },
  };

  const series: uPlot.Series[] = split
    ? [
        base,
        // Same stroke colour on both halves — the reader must see one series
        // changing texture, not two series in slightly different colours.
        {
          ...base,
          width: FLAGGED_WIDTH,
          dash: FLAGGED_DASH,
          alpha: FLAGGED_ALPHA,
        },
      ]
    : [base];

  plot = new uPlot(
    {
      width: el.chart.clientWidth || 640,
      height: 260,
      legend: { show: false },
      cursor: {
        show: true,
        points: {
          // One hover dot per LOGICAL series: uPlot builds one per uPlot series,
          // so without this a split series shows two dots stacked at one spot.
          show: ((_self: uPlot, seriesIdx: number) => seriesIdx === 1) as unknown as boolean,
        },
      },
      hooks: { setCursor: [onCursor] },
      scales: { x: { time: true } },
      axes: [
        { stroke: axisStroke, font, grid: { show: true, stroke: grid, width: 1 }, ticks: { show: false } },
        {
          stroke: axisStroke,
          font,
          grid: { show: true, stroke: grid, width: 1 },
          ticks: { show: false },
          values: (_self, splits) => splits.map((s) => formatAxisValue(s, payload.unit)),
        },
      ],
      series: [{}, ...series],
    },
    data,
    el.chart,
  );

  clearReadout();
}

function onCursor(self: uPlot): void {
  const idx = self.cursor.idx;
  if (idx == null || !current || !segmentation) {
    clearReadout();
    return;
  }

  const point = current.points[idx];
  if (!point) {
    clearReadout();
    return;
  }

  const state = segmentation.stateAt[idx];
  const value = formatReadoutValue(point.v, current.unit);
  const when = formatTimestamp(point.t, current.interval);

  el.readout.replaceChildren();

  const line = document.createElement("div");
  line.className = "readout__line";
  line.innerHTML = `<span class="readout__time">${escapeHtml(when)}</span><span class="readout__value">${escapeHtml(value)}</span>`;
  el.readout.append(line);

  if (state === "flagged") {
    const mask = segmentation.flaggedMaskAt[idx];
    const note = document.createElement("div");
    note.className = "readout__note";
    note.textContent = reasonsForMask(mask, current.bits).join(" ");
    el.readout.append(note);
  } else if (state === "unassessed") {
    const note = document.createElement("div");
    note.className = "readout__note";
    note.textContent = "Collected before we started recording quality. Unchecked, not unreliable.";
    el.readout.append(note);
  }
}

function clearReadout(): void {
  el.readout.replaceChildren();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;",
  );
}

// The card is width-flexible; uPlot needs an explicit pixel width.
const observer = new ResizeObserver(() => {
  if (plot) plot.setSize({ width: el.chart.clientWidth || 640, height: 260 });
});
observer.observe(el.chart);
