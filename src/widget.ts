// The MCP Apps chart widget: server side.
//
// This module builds the payload the `ui://` chart app renders, and nothing
// else. Three invariants govern it, in this order:
//
//  1. THE TOOL CONTRACT DOES NOT MOVE. `content[0].text` stays byte-identical
//     to what it was before this file existed. The CLI (`cli/`) and the skill
//     (`skill/`) read that text; a widget is not allowed to cost them a single
//     character. Everything here lands in `_meta`, which is protocol metadata
//     and reaches no model.
//
//  2. NOT `structuredContent`. It is tempting — the MCP Apps docs describe it
//     as "kept out of model context" — but that is a HOST behaviour, not a
//     protocol guarantee. Core MCP ties `structuredContent` to `outputSchema`
//     and treats it as server-produced RESULT data; a host that does not
//     implement Apps may legitimately hand it to the model, which would double
//     the token cost of a 50,000-point series. `_meta` has no such reading.
//
//  3. THE BIT TABLE IS SERVED, NEVER MIRRORED. The widget draws flagged
//     buckets, so it needs the quality decode table — and it gets it here, from
//     `/v1/catalog`, forwarded into the payload. `collector/core/quality-flags.core.ts`
//     and `api/src/metrics/quality-flags.const.ts` carry the standing rule that
//     two copies is the most that may ever exist. This is not a third.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CatalogMetric, CatalogResponse, QualityBit, SeriesPoint } from "./types.js";

/** The `ui://` resource the chart tool points at. Path shape is arbitrary; this one is stable. */
export const WIDGET_URI = "ui://blackforge/series-chart.html";

/** The MIME type MCP Apps requires on a UI resource. */
export const WIDGET_MIME_TYPE = "text/html;profile=mcp-app";

/** The MCP Apps extension identifier, used for capability negotiation. */
export const UI_EXTENSION_ID = "io.modelcontextprotocol/ui";

/**
 * Our `_meta` key. Namespaced by domain so it can never collide with a key the
 * protocol, the SDK or another extension introduces later.
 */
export const CHART_META_KEY = "so.blackforge/chart";

/**
 * Point cap for the widget payload.
 *
 * The tool itself still serves every point it always did — this bounds only the
 * copy that rides along for rendering. A chat card is ~600px wide, so beyond a
 * couple of thousand points the wire cost buys no pixels. Above the cap the
 * payload is decimated and SAYS SO, in the payload and on screen; silently
 * thinning a series and calling it the same chart is the kind of quiet lie this
 * codebase's quality rail exists to prevent.
 */
export const MAX_WIDGET_POINTS = 2000;

/** One point, in the compact wire form the widget reads. Keys are short on purpose. */
export interface WidgetPoint {
  /** Timestamp, epoch ms. */
  t: number;
  /** Value, or null when the bucket has no row. */
  v: number | null;
  /** Bitwise OR of quality flags over the bucket. Omitted when the API sent none. */
  q?: number;
  /** Bitwise AND of quality flags over the bucket. Omitted when the API sent none. */
  qa?: number;
}

export interface WidgetPayload {
  /** Payload version. The widget refuses a version it does not know. */
  v: 1;
  exchange: string;
  symbol: string;
  metric: string;
  interval: string;
  /** Human label for the metric, from the catalog. Falls back to the key. */
  label: string;
  /** Catalog unit, drives axis formatting. Falls back to `count`. */
  unit: string;
  /** Catalog family. Decides WHICH flags contaminate this metric, and only those. */
  family?: string;
  points: WidgetPoint[];
  /** The served decode table. Empty when the catalog was unreachable — then nothing is dotted. */
  bits: QualityBit[];
  /** Present only when the payload was thinned. The widget prints this. */
  decimated?: { from: number; factor: number };
  columnsOmitted: string[];
}

/**
 * THE PAYLOAD IS ALWAYS ATTACHED. Do not add a capability gate here.
 *
 * An earlier version of this file gated on the client having negotiated
 * `io.modelcontextprotocol/ui` — either via `extensions` on the initialize
 * capabilities (SEP-1724) or via `io.modelcontextprotocol/clientCapabilities`
 * in the request `_meta` (spec revision 2026-07-28). It reads like the correct,
 * frugal thing to do. It is not, and this was caught by running the real thing
 * rather than by reasoning about it.
 *
 * The official reference host — `examples/basic-host` in `ext-apps` — declares
 * NO capabilities at all (`new Client({name, version})`, nothing else). It
 * discovers widgets purely by reading `_meta.ui.resourceUri` off the tool. Under
 * the gate it rendered the iframe, received the tool result, found no payload
 * and printed "No chart data on this result." A host is not obliged to announce
 * anything, and hosts that render are demonstrably among those that do not.
 *
 * Nor is the resource read a usable signal: the spec explicitly allows a host to
 * preload the `ui://` resource BEFORE the tool is called, so its arrival order
 * relative to the call cannot be relied on.
 *
 * The cost of always attaching is bounded and small — `MAX_WIDGET_POINTS` caps
 * it regardless of how large the series is, the keys are one character, and it
 * rides in `_meta`, so it costs a model exactly nothing. The CLI does not use
 * MCP at all. That is a much better trade than a widget that silently does not
 * work on the reference host.
 */

/**
 * Whether a client ANNOUNCED MCP Apps support. Never use this to decide whether
 * to send the payload — see the note above. It exists for diagnostics: a host
 * that announces the extension and still shows no chart has a rendering problem,
 * not a payload problem.
 */
export function announcesWidgetSupport(
  initializeCapabilities: unknown,
  requestMeta: unknown,
): boolean {
  return hasUiExtension(initializeCapabilities) || hasUiExtension(pluckClientCaps(requestMeta));
}

function pluckClientCaps(requestMeta: unknown): unknown {
  if (!isRecord(requestMeta)) return undefined;
  return requestMeta["io.modelcontextprotocol/clientCapabilities"];
}

function hasUiExtension(capabilities: unknown): boolean {
  if (!isRecord(capabilities)) return false;
  const extensions = capabilities.extensions;
  if (!isRecord(extensions)) return false;
  return UI_EXTENSION_ID in extensions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Fold `count` adjacent points into one.
 *
 * The value taken is the LAST non-null in the group, which is what the API's
 * own coarser intervals do — a 1h bucket is not the mean of twelve 5m buckets.
 * The masks fold the way the API folds them: OR for `quality` (anything wrong
 * anywhere in the group), AND for `qualityAll` (wrong throughout). Getting
 * these two backwards would turn "briefly flagged" into "flagged throughout",
 * which is the exact distinction `sustainedAt` exists to preserve.
 */
function foldGroup(group: SeriesPoint[]): WidgetPoint {
  let value: number | null = null;
  for (let i = group.length - 1; i >= 0; i -= 1) {
    if (group[i].value != null) {
      value = group[i].value;
      break;
    }
  }

  let or: number | undefined;
  let and: number | undefined;
  for (const point of group) {
    if (typeof point.quality === "number") or = or === undefined ? point.quality : or | point.quality;
    if (typeof point.qualityAll === "number")
      and = and === undefined ? point.qualityAll : and & point.qualityAll;
  }

  return {
    t: group[0].ts,
    v: value,
    ...(or !== undefined ? { q: or } : {}),
    ...(and !== undefined ? { qa: and } : {}),
  };
}

/** Compact a point for the wire, dropping the two quality keys when the API sent none. */
function compact(point: SeriesPoint): WidgetPoint {
  return {
    t: point.ts,
    v: point.value,
    ...(typeof point.quality === "number" ? { q: point.quality } : {}),
    ...(typeof point.qualityAll === "number" ? { qa: point.qualityAll } : {}),
  };
}

export interface DecimateResult {
  points: WidgetPoint[];
  decimated?: { from: number; factor: number };
}

/** Bring a series under `MAX_WIDGET_POINTS`, reporting the factor when it had to. */
export function decimate(points: SeriesPoint[], max = MAX_WIDGET_POINTS): DecimateResult {
  if (points.length <= max) return { points: points.map(compact) };

  const factor = Math.ceil(points.length / max);
  const out: WidgetPoint[] = [];
  for (let i = 0; i < points.length; i += factor) {
    out.push(foldGroup(points.slice(i, i + factor)));
  }
  return { points: out, decimated: { from: points.length, factor } };
}

/** Look one metric up in the catalog. Undefined is fine — the widget degrades to the key. */
export function findMetric(
  catalog: CatalogResponse | undefined,
  key: string,
): CatalogMetric | undefined {
  return catalog?.metrics.find((m) => m.key === key);
}

/**
 * Read the built widget HTML off disk, once per process.
 *
 * Two candidate paths because the built server lives at `dist/index.js` (so the
 * widget is a sibling directory) while a `tsx src/index.ts` dev run sits one
 * level up. Neither is a fallback for a missing build: if both miss, the caller
 * gets the rejection and the resource read fails loudly rather than serving an
 * empty frame.
 */
let htmlPromise: Promise<string> | undefined;
export function widgetHtml(): Promise<string> {
  if (!htmlPromise) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.join(here, "widget", "chart.html"),
      path.join(here, "..", "dist", "widget", "chart.html"),
    ];
    htmlPromise = (async () => {
      for (const candidate of candidates) {
        try {
          return await readFile(candidate, "utf-8");
        } catch {
          // try the next candidate
        }
      }
      htmlPromise = undefined; // allow a retry after a rebuild
      throw new Error(
        `widget HTML not found (looked in ${candidates.join(", ")}) — run \`npm run build\``,
      );
    })();
  }
  return htmlPromise;
}

export function buildChartPayload(input: {
  exchange: string;
  symbol: string;
  metric: string;
  interval: string;
  points: SeriesPoint[];
  meta: CatalogMetric | undefined;
  bits: QualityBit[];
  columnsOmitted: string[];
}): WidgetPayload {
  const { points, decimated } = decimate(input.points);

  return {
    v: 1,
    exchange: input.exchange,
    symbol: input.symbol,
    metric: input.metric,
    interval: input.interval,
    label: input.meta?.label ?? input.metric,
    unit: input.meta?.unit ?? "count",
    ...(input.meta?.family ? { family: input.meta.family } : {}),
    points,
    bits: input.bits,
    ...(decimated ? { decimated } : {}),
    columnsOmitted: input.columnsOmitted,
  };
}
