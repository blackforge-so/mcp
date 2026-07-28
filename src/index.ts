#!/usr/bin/env node
// BlackForge MCP server — the whole crypto market, in real time.
// A thin stdio server exposing the BlackForge /v1 market-data API as MCP tools.
// Every tool returns raw measurements over 9 spot venues, one wide row per
// (exchange, symbol) per 5-minute window; blackforge_catalog lists the exact
// column set. This is market-data, not advice.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BlackForgeClient, type Result } from "./client.js";
import {
  anyFlagged,
  bitsFromCatalog,
  shapeCatalog,
  shapeLatest,
  shapeSeries,
  summarizeQuality,
} from "./shape.js";
import { BlackForgeApiError, type BlackForgeMeta, type QualityBit } from "./types.js";

const VERSION = "0.1.0";

const client = new BlackForgeClient();

const server = new McpServer({ name: "blackforge", version: VERSION });

/**
 * Wrap a client call: return compact JSON text, translate errors into tool errors.
 *
 * `shape` must SPREAD the raw payload and only ADD derived fields — never list
 * keys explicitly. An allowlist drops any new sibling key the API starts
 * sending before the model ever sees it.
 */
async function respond<T>(
  run: () => Promise<Result<T>>,
  shape: (data: T, meta: BlackForgeMeta) => unknown | Promise<unknown>,
) {
  try {
    const { data, meta } = await run();
    const payload = await shape(data, meta);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
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
 * The quality-flag decode table, read from the catalog and cached for the
 * process. Never hardcode a copy of it: a local mirror of this table has
 * already caused one production incident in this programme. On failure we fall
 * back to raw masks and let the next call retry.
 */
let bitsPromise: Promise<QualityBit[]> | undefined;
function qualityBits(): Promise<QualityBit[]> {
  if (!bitsPromise) {
    bitsPromise = client
      .catalog()
      .then(({ data }) => bitsFromCatalog(data))
      .catch(() => {
        bitsPromise = undefined; // transient failure: allow a retry later
        return [];
      });
  }
  return bitsPromise;
}

// ── blackforge_catalog ───────────────────────────────────────────────────────
server.registerTool(
  "blackforge_catalog",
  {
    title: "BlackForge catalog",
    description:
      "List every venue BlackForge covers (9 spot exchanges) and every column it measures " +
      "(one wide row per (exchange, symbol) per 5-minute window: order-book depth and " +
      "shape, resting-liquidity lifetimes, trade-explained vs book-implied volume, spreads, " +
      "and market-wide context). `metricCount` is the exact number of columns available now. " +
      "Each metric carries a precise measurement definition, unit, family, and the minimum " +
      "plan that includes it; the `qualityFlags` metric also carries the `bits` table that " +
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
    description:
      "Return the latest completed 5-minute window for one (exchange, symbol): a `values` object " +
      "mapping each column key to its measured number (or null when not observed), plus the window " +
      "timestamp `ts` in epoch milliseconds. Omit `columns` to get every column your plan includes; " +
      "pass a subset of column keys (from blackforge_catalog) to narrow the payload. Columns your plan " +
      "does not cover are dropped and reported in `columnsOmitted` so you can see why a key is absent. " +
      "WHEN PRESENT, a `quality` object reports the row's measurement quality — `flags` names what " +
      "went wrong during the window and `contaminates` lists which figures it flags, " +
      "with a plain-English `qualityNote` beside it. Read it before trusting an unusual value. " +
      "A `quality.raw` of 32768 means the row predates the quality rail and was never assessed — " +
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
    description:
      "Return a time series for one column of one (exchange, symbol): `points` is an ascending array " +
      "of { ts, value } where `ts` is epoch milliseconds and `value` is the measured number (or null). " +
      "`from`/`to` are ISO-8601 datetimes; `interval` is one of 5m, 1h, 1d (higher intervals may be " +
      "plan-gated). The server caps a response at 50,000 points. If the requested `metric` is above your " +
      "plan, `points` comes back empty and the column is listed in `columnsOmitted` — that is why it is empty. " +
      "WHEN ANY BUCKET IS FLAGGED, a `qualitySummary` object reports how many of the buckets carry a " +
      "quality flag and which flags they are (`{ flaggedBuckets, of, flags }`); per-bucket quality is " +
      "deliberately not repeated on every point. No `qualitySummary` means no bucket in the range was flagged.",
    inputSchema: {
      exchange: z.string().describe("Venue identifier, e.g. binance."),
      symbol: z.string().describe("Trading pair, e.g. BTCUSDT."),
      metric: z.string().describe("Column key from blackforge_catalog, e.g. spreadMean."),
      from: z.string().describe("Start datetime, ISO-8601, e.g. 2026-07-01T00:00:00Z."),
      to: z.string().describe("End datetime, ISO-8601, e.g. 2026-07-02T00:00:00Z."),
      interval: z.enum(["5m", "1h", "1d"]).describe("Bucket size: 5m, 1h, or 1d."),
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
    ),
);

// ── blackforge_usage ─────────────────────────────────────────────────────────
server.registerTool(
  "blackforge_usage",
  {
    title: "BlackForge usage",
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
