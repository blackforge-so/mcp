#!/usr/bin/env node
// BlackForge MCP server — the whole crypto market, in real time.
// A thin stdio server exposing the BlackForge /v1 market-data API as MCP tools.
// Every tool returns raw measurements over 9 spot venues and up to 117 columns
// per (exchange, symbol) per 5-minute window. This is market-data, not advice.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BlackForgeClient, type Result } from "./client.js";
import { BlackForgeApiError, type BlackForgeMeta } from "./types.js";

const VERSION = "0.1.0";

const client = new BlackForgeClient();

const server = new McpServer({ name: "blackforge", version: VERSION });

/** Wrap a client call: return compact JSON text, translate errors into tool errors. */
async function respond<T>(
  run: () => Promise<Result<T>>,
  shape: (data: T, meta: BlackForgeMeta) => unknown,
) {
  try {
    const { data, meta } = await run();
    const payload = shape(data, meta);
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

// ── blackforge_catalog ───────────────────────────────────────────────────────
server.registerTool(
  "blackforge_catalog",
  {
    title: "BlackForge catalog",
    description:
      "List every venue BlackForge covers (9 spot exchanges) and every column it measures " +
      "(up to 117 columns per (exchange, symbol) per 5-minute window: order-book depth and " +
      "shape, resting-liquidity lifetimes, trade-explained vs book-implied volume, spreads, " +
      "and market-wide context). Each metric carries a precise measurement definition, unit, " +
      "family, and the minimum plan that includes it. This route needs no API key. " +
      "CALL THIS FIRST to learn the exact `exchange` and `metric` identifiers the other tools accept.",
    inputSchema: {},
  },
  () =>
    respond(
      () => client.catalog(),
      (data) => ({
        venues: data.venues,
        metricCount: data.metrics.length,
        metrics: data.metrics,
      }),
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
      "does not cover are dropped and reported in `columnsOmitted` so you can see why a key is absent.",
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
      (data, meta) => ({
        exchange,
        symbol,
        ts: data.ts,
        tsIso: data.ts ? new Date(data.ts).toISOString() : null,
        valueCount: Object.keys(data.values).length,
        values: data.values,
        rowsRemaining: meta.rowsRemaining,
        columnsOmitted: meta.columnsOmitted ?? [],
      }),
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
      "plan, `points` comes back empty and the column is listed in `columnsOmitted` — that is why it is empty.",
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
      (data, meta) => ({
        exchange,
        symbol,
        metric,
        interval,
        pointCount: data.points.length,
        points: data.points,
        columnsOmitted: meta.columnsOmitted ?? [],
      }),
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
      (data) => ({ days: data.days, rowsRemaining: data.rowsRemaining }),
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
        "all other tools need one. Get a key at app.blackforge.so → Keys.\n",
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
