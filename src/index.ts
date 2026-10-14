#!/usr/bin/env node
// BlackForge MCP server — the whole crypto market, in real time.
// A thin stdio server exposing the BlackForge /v1 market-data API as MCP tools.
// Every tool returns raw measurements over 9 spot venues, one wide row per
// (exchange, symbol) per minute (served as 1m on Ultra/PAYG, 5m/1h/1d rollups
// for everyone); blackforge_catalog lists the exact
// column set. This is market-data, not advice.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BlackForgeClient, type Result } from "./client.js";
import { registerRealtimeTools } from "./realtime-tools.js";
import {
  anyFlagged,
  bitsFromCatalog,
  shapeCatalog,
  shapeLatest,
  shapeSeries,
  summarizeQuality,
} from "./shape.js";
import {
  CHART_META_KEY,
  WIDGET_MIME_TYPE,
  WIDGET_URI,
  buildChartPayload,
  findMetric,
  widgetHtml,
} from "./widget.js";
import {
  BlackForgeApiError,
  type BlackForgeMeta,
  type CatalogResponse,
  type QualityBit,
} from "./types.js";

const VERSION = "0.3.0";

const client = new BlackForgeClient();

const server = new McpServer({ name: "blackforge", version: VERSION });

/** The five /v1 history tools only read. They reach the network, so openWorldHint. */
const HISTORY_READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

/**
 * Wrap a client call: return compact JSON text, translate errors into tool errors.
 *
 * `shape` must SPREAD the raw payload and only ADD derived fields — never list
 * keys explicitly. An allowlist drops any new sibling key the API starts
 * sending before the model ever sees it.
 *
 * `sidecar` is the ONLY other channel, and it is strictly out-of-band: whatever
 * it returns lands in the result's `_meta`, which is protocol metadata and is
 * never handed to a model. `content[0].text` is identical with it and without
 * it, so a host that renders widgets and one that does not put exactly the same
 * bytes in front of the model. That is what keeps `cli/` and `skill/` — which
 * read that text — unaffected by anything in this file.
 */
async function respond<T>(
  run: () => Promise<Result<T>>,
  shape: (data: T, meta: BlackForgeMeta) => unknown | Promise<unknown>,
  sidecar?: (data: T, meta: BlackForgeMeta) => Promise<Record<string, unknown> | undefined>,
) {
  try {
    const { data, meta } = await run();
    const payload = await shape(data, meta);
    const extra = sidecar ? await sidecar(data, meta) : undefined;
    return {
      content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      ...(extra ? { _meta: extra } : {}),
    };
  } catch (err) {
    const text =
      err instanceof BlackForgeApiError
        ? `BlackForge API error (HTTP ${err.status}): ${err.message}`
        : `BlackForge MCP error: ${(err as Error).message}`;
    return { isError: true, content: [{ type: "text" as const, text }] };
  }
}

/**
 * The catalog, fetched at most once per process.
 *
 * It carries two things this server cannot derive locally: the quality-flag
 * decode table, and each metric's unit / family / label. Never hardcode a copy
 * of the bit table — a local mirror of it has already caused one production
 * incident in this programme. On failure we fall back to raw masks and let the
 * next call retry.
 */
let catalogPromise: Promise<CatalogResponse | undefined> | undefined;
function cachedCatalog(): Promise<CatalogResponse | undefined> {
  if (!catalogPromise) {
    catalogPromise = client
      .catalog()
      .then(({ data }) => data)
      .catch(() => {
        catalogPromise = undefined; // transient failure: allow a retry later
        return undefined;
      });
  }
  return catalogPromise;
}

function qualityBits(): Promise<QualityBit[]> {
  return cachedCatalog().then((catalog) => (catalog ? bitsFromCatalog(catalog) : []));
}

// ── the chart widget resource (MCP Apps) ─────────────────────────────────────
// A `ui://` resource holding one self-contained HTML file. Hosts that
// implement the `io.modelcontextprotocol/ui` extension fetch this when
// blackforge_series is called and render it in a sandboxed iframe; every other
// host ignores both this resource and the tool's `_meta.ui`, and sees the exact
// same tool result it saw before.
//
// No `_meta.ui.csp` is declared, on purpose. The widget makes no network calls
// — its data arrives on the tool result — so it needs neither `connectDomains`
// nor `resourceDomains`, and it renders correctly under the deny-by-default
// policy. Adding a CSP entry here would be widening the sandbox for nothing.
server.registerResource(
  "BlackForge series chart",
  WIDGET_URI,
  {
    mimeType: WIDGET_MIME_TYPE,
    description:
      "Interactive chart for a blackforge_series result: one metric over time, with " +
      "flagged buckets drawn in the same convention the BlackForge dashboard uses.",
  },
  async () => ({
    contents: [{ uri: WIDGET_URI, mimeType: WIDGET_MIME_TYPE, text: await widgetHtml() }],
  }),
);

// ── blackforge_catalog ───────────────────────────────────────────────────────
server.registerTool(
  "blackforge_catalog",
  {
    title: "BlackForge catalog",
    annotations: HISTORY_READ,
    description:
      "List every venue BlackForge covers (9 spot exchanges) and every column it measures " +
      "(one wide row per (exchange, symbol) per minute, served at 1m, 5m, 1h and 1d: order-book depth and " +
      "shape, resting-liquidity lifetimes, trade-explained vs book-implied volume, spreads, " +
      "and market-wide context). `metricCount` is the exact number of columns available now. " +
      "Each metric carries a precise measurement definition, unit, family, and the minimum " +
      "plan that includes it, the `intervals` it is served at, and, where the 5m/1h/1d value is a rollup " +
      "of minute values rather than a re-measurement, a one-sentence `rollupNote`. `availableFrom[\"1m\"]` " +
      "is when the one-minute rows start (null before). The `qualityFlags` metric also carries the `bits` table that " +
      "decodes the per-row quality mask. This route needs no API key. " +
      "CALL THIS FIRST to learn the exact `exchange` and `metric` identifiers the other tools accept.",
    inputSchema: {},
  },
  () =>
    respond(
      () => client.catalog(),
      (data) => shapeCatalog(data),
    ),
);

// ── blackforge_symbols ───────────────────────────────────────────────────────
server.registerTool(
  "blackforge_symbols",
  {
    title: "BlackForge symbols",
    annotations: HISTORY_READ,
    description:
      "List the trading pairs (symbols) a given venue trades, as an array of symbol strings. " +
      "Use these values as the `symbol` argument to blackforge_latest and blackforge_series. " +
      "Valid `exchange` values come from blackforge_catalog (e.g. binance, bybit, coinbase, kraken, okx). " +
      "A venue outside the caller's plan returns HTTP 403 with the plan and an upgrade URL.",
    inputSchema: {
      exchange: z
        .string()
        .describe("Venue identifier from blackforge_catalog, e.g. binance, okx, coinbase."),
    },
  },
  ({ exchange }) =>
    respond(
      () => client.symbols(exchange),
      (data) => ({ exchange, count: data.length, symbols: data }),
    ),
);

// ── blackforge_latest ────────────────────────────────────────────────────────
server.registerTool(
  "blackforge_latest",
  {
    title: "BlackForge latest bucket",
    annotations: HISTORY_READ,
    description:
      "Return the latest completed bucket for one (exchange, symbol), at the key plan's interval " +
      "(1 minute on Ultra and PAYG, 5 minutes otherwise): a `values` object " +
      "mapping each column key to its measured number (or null when not observed), plus the window " +
      "END timestamp `ts` in epoch milliseconds. Omit `columns` to get every column your plan includes; " +
      "pass a subset of column keys (from blackforge_catalog) to narrow the payload. Columns your plan " +
      "does not cover are dropped and reported in `columnsOmitted` so you can see why a key is absent. " +
      "WHEN PRESENT, a `quality` object reports the row's measurement quality: `flags` names what " +
      "went wrong during the window and `contaminates` lists which figures it flags, " +
      "with a plain-English `qualityNote` beside it. Read it before trusting an unusual value. " +
      "A `quality.raw` of 32768 means the row predates the quality rail and was never assessed; " +
      "that is unknown, not bad. When the key is absent, the row carries no quality assessment at all.",
    inputSchema: {
      exchange: z.string().describe("Venue identifier, e.g. binance."),
      symbol: z.string().describe("Trading pair from blackforge_symbols, e.g. BTCUSDT."),
      columns: z
        .array(z.string())
        .optional()
        .describe("Optional subset of column keys from blackforge_catalog. Omit for all plan-included columns."),
    },
  },
  ({ exchange, symbol, columns }) =>
    respond(
      () => client.latest(exchange, symbol, columns),
      (data, meta) => shapeLatest(data, meta, { exchange, symbol }),
    ),
);

// ── blackforge_series ────────────────────────────────────────────────────────
server.registerTool(
  "blackforge_series",
  {
    title: "BlackForge time series",
    annotations: HISTORY_READ,
    description:
      "Return a time series for one column of one (exchange, symbol): `points` is an ascending array " +
      "of { ts, value } where `ts` is epoch milliseconds and `value` is the measured number (or null). " +
      "`from`/`to` are ISO-8601 datetimes; `interval` is one of 1m, 5m, 1h, 1d. 1m is on Ultra and PAYG " +
      "(PAYG bills a 1m row at five times a 5m row); Max and below go down to 5m, and a finer interval than " +
      "the plan allows is a 403. 1m rows exist only from the switch to one-minute rows on (see " +
      "blackforge_catalog `availableFrom`); for earlier ranges use 5m, which covers all history. The server " +
      "caps a response at 50,000 points (about 34 days at 1m) and keeps the NEWEST; `truncated: true` " +
      "says the range was cut, so narrow it or use a coarser interval. If the requested `metric` is above your " +
      "plan, `points` comes back empty and the column is listed in `columnsOmitted`, which is why it is empty. " +
      "WHEN ANY BUCKET IS FLAGGED, a `qualitySummary` object reports how many of the buckets carry a " +
      "quality flag and which flags they are (`{ flaggedBuckets, of, flags }`); per-bucket quality is " +
      "deliberately not repeated on every point. No `qualitySummary` means no bucket in the range was flagged.",
    // MCP Apps: hosts that support the extension render the result as an
    // interactive chart. Hosts that do not ignore this key entirely — it is
    // metadata on the tool definition, not part of the input or output
    // contract. Both spellings are set because older hosts read the flat one.
    _meta: {
      ui: { resourceUri: WIDGET_URI },
      "ui/resourceUri": WIDGET_URI,
    },
    inputSchema: {
      exchange: z.string().describe("Venue identifier, e.g. binance."),
      symbol: z.string().describe("Trading pair, e.g. BTCUSDT."),
      metric: z.string().describe("Column key from blackforge_catalog, e.g. spreadMean."),
      from: z.string().describe("Start datetime, ISO-8601, e.g. 2026-07-01T00:00:00Z."),
      to: z.string().describe("End datetime, ISO-8601, e.g. 2026-07-02T00:00:00Z."),
      interval: z
        .enum(["1m", "5m", "1h", "1d"])
        .describe("Bucket size: 1m (Ultra and PAYG), 5m, 1h, or 1d."),
    },
  },
  ({ exchange, symbol, metric, from, to, interval }) =>
    respond(
      () => client.series({ exchange, symbol, metric, from, to, interval }),
      async (data, meta) => {
        // Only pay for the decode table when something is actually flagged.
        const bits = anyFlagged(data.points) ? await qualityBits() : [];
        const summary = summarizeQuality(data.points, bits);
        return shapeSeries(data, meta, { exchange, symbol, metric, interval }, summary);
      },
      // The widget sidecar. ALWAYS attached — never gate this on the client
      // having announced `io.modelcontextprotocol/ui`. The official reference
      // host declares no capabilities at all and still renders widgets, so a
      // gate makes the chart silently empty there. Full reasoning in
      // `widget.ts`. The cost is bounded by MAX_WIDGET_POINTS and lands in
      // `_meta`, so it reaches no model.
      async (data, meta) => {
        // Unlike the summary above, the widget needs the table whenever it
        // might dot something, and the catalog for the metric's unit + family.
        const catalog = await cachedCatalog();
        return {
          [CHART_META_KEY]: buildChartPayload({
            exchange,
            symbol,
            metric,
            interval,
            points: data.points,
            meta: findMetric(catalog, metric),
            bits: catalog ? bitsFromCatalog(catalog) : [],
            columnsOmitted: meta.columnsOmitted ?? [],
          }),
        };
      },
    ),
);

// ── blackforge_usage ─────────────────────────────────────────────────────────
server.registerTool(
  "blackforge_usage",
  {
    title: "BlackForge usage",
    annotations: HISTORY_READ,
    description:
      "Report the calling key's recent usage: `days` is a per-day breakdown of request counts and the " +
      "last request time, and `rowsRemaining` is the monthly row quota still available (omitted for " +
      "usage-based plans that have no monthly ceiling). Use this to check headroom before a large pull.",
    inputSchema: {},
  },
  () =>
    respond(
      () => client.usage(),
      (data) => ({ ...data }),
    ),
);

// ── live formulas, notifications and live order book reads ──────────────────
registerRealtimeTools(server);

// ── boot ─────────────────────────────────────────────────────────────────────
async function main() {
  // Warn (do not exit) when no key is set: blackforge_catalog still works keyless,
  // so a user can verify the install before pasting a key. Keyed tools return a
  // clear error at call time.
  if (!client.hasKey()) {
    process.stderr.write(
      "[blackforge-mcp] BLACKFORGE_API_KEY is not set. blackforge_catalog works without a key; " +
        "all other tools need one. Get a key at app.blackforge.so → API.\n",
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[blackforge-mcp] server ready on stdio (BlackForge market-data).\n");
}

main().catch((err) => {
  process.stderr.write(`[blackforge-mcp] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
