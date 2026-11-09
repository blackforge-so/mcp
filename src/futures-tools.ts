// MCP tools for the linear futures contracts (perpetual and dated) under
// /v1/futures/*. Registered from index.ts; kept here so index.ts stays the spot
// history tools. Same key, meter, error text and additive shaping as those.
//
// Copy rules for every string below (MCP hosts show them to users): no em
// dashes, no small exact venue counts, raw data. Descriptions say what a field
// IS; they never tell the agent what to do.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BlackForgeClient, Result } from "./client.js";
import {
  anyFlagged,
  futuresBitsFromCatalog,
  shapeFuturesLatest,
  shapeFuturesLiquidations,
  shapeFuturesTop,
  shapeSeries,
  summarizeQuality,
} from "./shape.js";
import { CHART_META_KEY, WIDGET_URI, buildChartPayload, findFuturesMetric } from "./widget.js";
import { BlackForgeApiError, type BlackForgeMeta, type CatalogResponse } from "./types.js";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

/** Same contract as `respond()` in index.ts: spread-and-add shaping, `_meta` sidecar only. */
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

const SYMBOL_SPELLING =
  "Contracts are spelled the way each venue spells them: binance, bybit and bitget `BTCUSDT`, okx " +
  "`BTC-USDT-SWAP`, gate and mexc `BTC_USDT`, kucoin `XBTUSDTM`, dated contracts such as `BTCUSDT_261225`.";

const PLAN_INTERVALS = "1m on Ultra and PAYG, 5m on Max, 1h on Pro, 1d on Free";

export function registerFuturesTools(
  server: McpServer,
  client: BlackForgeClient,
  catalog: () => Promise<CatalogResponse | undefined>,
): void {
  // ── blackforge_futures_symbols ──
  server.registerTool(
    "blackforge_futures_symbols",
    {
      title: "BlackForge futures contracts",
      annotations: READ,
      description:
        "The linear futures contracts (perpetual and dated) a futures venue lists now, as an array of contract " +
        "symbols: the `symbol` values blackforge_futures_latest and blackforge_futures_series accept. " +
        SYMBOL_SPELLING +
        " The futures venues and the plan each needs are under `futures.venues` in blackforge_catalog; a venue " +
        "outside the key's plan is an HTTP 403 carrying the plan and an upgrade URL. Not metered.",
      inputSchema: {
        exchange: z.string().describe("Futures venue from blackforge_catalog `futures.venues`, e.g. binance, okx, bybit."),
      },
    },
    ({ exchange }) =>
      respond(
        () => client.futuresSymbols(exchange),
        (data) => ({ exchange, count: data.length, symbols: data }),
      ),
  );

  // ── blackforge_futures_latest ──
  server.registerTool(
    "blackforge_futures_latest",
    {
      title: "BlackForge futures latest bucket",
      annotations: READ,
      description:
        "The latest complete bucket for one linear futures contract at the key plan's interval (" +
        PLAN_INTERVALS +
        "). `values` maps each futures column key to its value: a number, a string for the text columns " +
        "(`baseAsset`, `quoteAsset`, `contractType`), or null where the venue did not publish it. `ts` (epoch " +
        "milliseconds, with `tsIso`) and `interval` identify the bucket; `ts` is 0 with empty `values` when the " +
        "contract has no row. The columns are defined under `futures.metrics` in blackforge_catalog: mark, index, " +
        "last, best bid and best ask prices; `fundingRate` (per funding interval, a fraction: 0.0001 = 0.01%; " +
        "venues settle at different intervals) and `nextFundingTime`; `openInterest` (base units) and " +
        "`openInterestValue` (quote currency) with `openInterestAt`; volume, taker buy volume and trade count; " +
        "and long and short liquidation counts and notionals (Max and up). `columns` narrows the payload; " +
        "columns above the plan are dropped and listed in `columnsOmitted`. When present, `quality` holds the " +
        "row's futures quality `flags` and the column families they call into question (`contaminates`), with " +
        "a plain-English `qualityNote`; the decode table is `futures.qualityBits` in blackforge_catalog. " +
        SYMBOL_SPELLING,
      inputSchema: {
        exchange: z.string().describe("Futures venue, e.g. binance."),
        symbol: z.string().describe("Contract from blackforge_futures_symbols, e.g. BTCUSDT or BTC-USDT-SWAP."),
        columns: z
          .array(z.string())
          .optional()
          .describe("Optional subset of futures column keys. Omitted: every column the plan includes."),
      },
    },
    ({ exchange, symbol, columns }) =>
      respond(
        () => client.futuresLatest(exchange, symbol, columns),
        (data, meta) => shapeFuturesLatest(data, meta, { exchange, symbol }),
      ),
  );

  // ── blackforge_futures_series ──
  server.registerTool(
    "blackforge_futures_series",
    {
      title: "BlackForge futures time series",
      annotations: READ,
      description:
        "A time series of one numeric futures column for one contract: `points` is an ascending array of " +
        "{ ts, value } with `ts` in epoch milliseconds and `value` the number or null. `from`/`to` are ISO-8601 " +
        "datetimes; `interval` is one of 1m, 5m, 1h, 1d, and an interval finer than the plan's (" +
        PLAN_INTERVALS +
        ") is an HTTP 403. Futures history is a rolling window: `futures.historyDays` and " +
        "`futures.availableFrom` in blackforge_catalog, shorter on Free; a `from` before the plan's window is " +
        "moved forward to it without an error, so the first point can start later than asked. Flows (volume, " +
        "taker volume, trades, liquidations) are summed into a bucket; prices, funding and open interest are " +
        "the bucket's last minute (`rollup` on each catalog entry). At most 50,000 points, newest kept, with " +
        "`truncated: true` when cut. A column above the plan comes back with empty `points` and is listed in " +
        "`columnsOmitted`. When any bucket is flagged, `qualitySummary` (`{ flaggedBuckets, of, flags }`) " +
        "names the futures quality flags; no `qualitySummary` means no bucket in the range was flagged.",
      // MCP Apps: the same chart widget as blackforge_series. Hosts without the
      // extension ignore this key; the tool contract does not depend on it.
      _meta: {
        ui: { resourceUri: WIDGET_URI },
        "ui/resourceUri": WIDGET_URI,
      },
      inputSchema: {
        exchange: z.string().describe("Futures venue, e.g. bybit."),
        symbol: z.string().describe("Contract from blackforge_futures_symbols, e.g. BTCUSDT."),
        metric: z
          .string()
          .describe("Numeric futures column key from blackforge_catalog `futures.metrics`, e.g. fundingRate, openInterestValue."),
        from: z.string().describe("Start datetime, ISO-8601, e.g. 2026-11-08T00:00:00Z."),
        to: z.string().describe("End datetime, ISO-8601, e.g. 2026-11-09T00:00:00Z."),
        interval: z.enum(["1m", "5m", "1h", "1d"]).describe("Bucket size: 1m (Ultra and PAYG), 5m (Max), 1h, or 1d."),
      },
    },
    ({ exchange, symbol, metric, from, to, interval }) =>
      respond(
        () => client.futuresSeries({ exchange, symbol, metric, from, to, interval }),
        async (data, meta) => {
          const bits = anyFlagged(data.points)
            ? await catalog().then((c) => (c ? futuresBitsFromCatalog(c) : []))
            : [];
          const summary = summarizeQuality(data.points, bits);
          return shapeSeries(data, meta, { exchange, symbol, metric, interval }, summary);
        },
        // The widget sidecar, always attached (see widget.ts for why it is never
        // gated on the client's capabilities). It rides in `_meta` only.
        async (data, meta) => {
          const c = await catalog();
          return {
            [CHART_META_KEY]: buildChartPayload({
              exchange,
              symbol,
              metric,
              interval,
              points: data.points,
              meta: findFuturesMetric(c, metric),
              bits: c ? futuresBitsFromCatalog(c) : [],
              columnsOmitted: meta.columnsOmitted ?? [],
            }),
          };
        },
      ),
  );

  // ── blackforge_futures_top ──
  server.registerTool(
    "blackforge_futures_top",
    {
      title: "BlackForge futures ranking",
      annotations: READ,
      description:
        "Futures contracts ranked by one numeric column on the latest complete bucket at the key plan's " +
        "interval, on one venue (`exchange`) or across every futures venue the plan includes. `rows` is an " +
        "array of { exchange, symbol, baseAsset, value } in `order` (`desc`, the default, is largest first), " +
        "with the bucket's `ts` (epoch milliseconds, with `tsIso`) and `interval`. `baseAsset` (e.g. BTC) " +
        "keeps one coin, which with no `exchange` puts that coin's contracts on every venue side by side; " +
        "`contractType` keeps `perpetual` or `dated` contracts. `limit` is 1 to 100 (default 50). `metric` is " +
        "a numeric key from blackforge_catalog `futures.metrics`, e.g. fundingRate, openInterestValue, " +
        "quoteVolume, or liqLongNotional (Max and up). A funding rate is per the venue's funding interval, " +
        "which is not the same on every venue.",
      inputSchema: {
        metric: z.string().describe("Numeric futures column key, e.g. fundingRate."),
        exchange: z.string().optional().describe("One futures venue. Omitted: every futures venue the plan includes."),
        baseAsset: z.string().optional().describe("One coin as `baseAsset` spells it, e.g. BTC (kucoin XBT reads BTC)."),
        contractType: z.enum(["perpetual", "dated"]).optional().describe("perpetual (funded, no expiry) or dated."),
        order: z.enum(["desc", "asc"]).optional().describe("desc (largest first, the default) or asc."),
        limit: z.number().int().min(1).max(100).optional().describe("Rows, 1 to 100. Default 50."),
      },
    },
    (args) =>
      respond(
        () => client.futuresTop(args),
        (data, meta) => shapeFuturesTop(data, meta),
      ),
  );

  // ── blackforge_futures_liquidations ──
  server.registerTool(
    "blackforge_futures_liquidations",
    {
      title: "BlackForge futures liquidations",
      annotations: READ,
      description:
        "Individual liquidation events from the futures venues that publish a public liquidation feed, newest " +
        "first. `events` is an array of { ts, exchange, symbol, side, price, quantity, notional }: `ts` is the " +
        "venue's time in epoch milliseconds, `side` is the POSITION liquidated (a long is closed by a forced " +
        "sell), `quantity` is in base units and `notional` in the quote currency. `from`/`to` (ISO-8601) default " +
        "to the last hour, echoed as `fromIso`/`toIso`; `limit` is 1 to 1000 (default 100) and `truncated: true` " +
        "means the window held more. Feed coverage per venue is `futures.venues[].liquidations` in " +
        "blackforge_catalog: `complete` sends every liquidation, `lowerBound` is throttled by the venue so a " +
        "cascade is undercounted, null publishes none; `feedNote` names the lower-bound venues present in the " +
        "result. Max, Ultra and PAYG; below Max this is an HTTP 403 with an upgrade URL.",
      inputSchema: {
        exchange: z.string().optional().describe("One futures venue. Omitted: every venue with a feed the plan includes."),
        symbol: z.string().optional().describe("One contract, as the venue spells it."),
        side: z.enum(["long", "short"]).optional().describe("The position liquidated: long or short."),
        from: z.string().optional().describe("Start datetime, ISO-8601. Default: one hour before `to`."),
        to: z.string().optional().describe("End datetime, ISO-8601. Default: now."),
        limit: z.number().int().min(1).max(1000).optional().describe("Events, 1 to 1000. Default 100."),
      },
    },
    (args) =>
      respond(
        () => client.futuresLiquidations(args),
        async (data, meta) => {
          // Which feeds are throttled is served by the catalog; only fetched when
          // there is an event to qualify.
          const lowerBound = data.events.length
            ? ((await catalog())?.futures?.venues ?? [])
                .filter((v) => v.liquidations === "lowerBound")
                .map((v) => v.venue)
            : [];
          return shapeFuturesLiquidations(data, meta, lowerBound);
        },
      ),
  );
}
