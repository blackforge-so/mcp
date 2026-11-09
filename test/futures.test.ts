import { afterEach, describe, expect, it, vi } from "vitest";
import { BlackForgeClient } from "../src/client.js";
import { BlackForgeApiError, type CatalogResponse } from "../src/types.js";
import {
  futuresBitsFromCatalog,
  liquidationFeedNote,
  qualityNote,
  shapeCatalog,
  shapeFuturesLatest,
  shapeFuturesLiquidations,
  shapeFuturesTop,
} from "../src/shape.js";
import { buildChartPayload, findFuturesMetric } from "../src/widget.js";

// The futures surface over /v1/futures/*, against a mocked fetch, plus the
// shapers. Runs without a build and without an API.

function mockFetch(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
  return vi.fn(
    async (..._args: unknown[]) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
      }),
  );
}

function urlOf(spy: ReturnType<typeof mockFetch>, call = 0): URL {
  return new URL((spy.mock.calls[call][0] as URL).toString());
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const CATALOG: CatalogResponse = {
  venues: [],
  metrics: [
    {
      key: "qualityFlags",
      label: "Row quality flags",
      family: "quality",
      unit: "count",
      quoteRelative: false,
      nullable: false,
      description: "",
      howToRead: "",
      minPlan: "free",
      bits: [{ bit: 0, mask: 1, name: "BOOK_DESYNCED" }],
    },
  ],
  futures: {
    venues: [
      { venue: "binance", minPlan: "free", liquidations: "lowerBound" },
      { venue: "bybit", minPlan: "pro", liquidations: "complete" },
      { venue: "okx", minPlan: "pro", liquidations: "lowerBound" },
      { venue: "mexc", minPlan: "free", liquidations: null },
    ],
    metrics: [
      { key: "markPrice", label: "Mark price", family: "price", unit: "price", minPlan: "free" },
      { key: "fundingRate", label: "Funding rate", family: "funding", unit: "ratio", minPlan: "free" },
      { key: "liqLongCount", label: "Long liquidations", family: "liquidations", unit: "count", minPlan: "max" },
      { key: "rowVersion", label: "Row version", family: "quality", unit: "count", minPlan: null, internal: true },
    ],
    qualityBits: [
      { bit: 0, mask: 1, name: "QUOTE_MISSING", contaminates: ["price", "funding", "openInterest"] },
      { bit: 1, mask: 2, name: "TRADES_PARTIAL", contaminates: ["tradeFlow"] },
    ],
    liquidationEvents: { minPlan: "max", fields: [] },
    availableFrom: "2026-11-07T22:04:00.000Z",
    historyDays: 60,
  },
};

describe("futures client paths", () => {
  const keyed = () => new BlackForgeClient({ baseUrl: "http://x/api", apiKey: "bf_test" });

  it("symbols, latest, series hit /v1/futures/* with the key", async () => {
    const spy = mockFetch(["BTC-USDT-SWAP"]);
    vi.stubGlobal("fetch", spy);
    await keyed().futuresSymbols("okx");
    expect(urlOf(spy).pathname).toBe("/api/v1/futures/symbols");
    expect(urlOf(spy).searchParams.get("exchange")).toBe("okx");
    expect((spy.mock.calls[0][1] as RequestInit).headers).toHaveProperty("x-api-key", "bf_test");

    const latest = mockFetch({ ts: 1, values: {} });
    vi.stubGlobal("fetch", latest);
    await keyed().futuresLatest("binance", "BTCUSDT", ["markPrice", "fundingRate"]);
    expect(urlOf(latest).pathname).toBe("/api/v1/futures/latest");
    expect(urlOf(latest).searchParams.get("columns")).toBe("markPrice,fundingRate");

    const series = mockFetch({ points: [] });
    vi.stubGlobal("fetch", series);
    await keyed().futuresSeries({
      exchange: "bybit",
      symbol: "BTCUSDT",
      metric: "fundingRate",
      from: "2026-11-08T00:00:00Z",
      to: "2026-11-09T00:00:00Z",
      interval: "1h",
    });
    expect(urlOf(series).pathname).toBe("/api/v1/futures/series");
    expect(Object.fromEntries(urlOf(series).searchParams)).toEqual({
      exchange: "bybit",
      symbol: "BTCUSDT",
      metric: "fundingRate",
      from: "2026-11-08T00:00:00Z",
      to: "2026-11-09T00:00:00Z",
      interval: "1h",
    });
  });

  it("top and liquidations send only what was given, numbers as strings", async () => {
    const top = mockFetch({ metric: "fundingRate", ts: 1, rows: [] });
    vi.stubGlobal("fetch", top);
    await keyed().futuresTop({ metric: "fundingRate", baseAsset: "BTC", limit: 10 });
    expect(urlOf(top).pathname).toBe("/api/v1/futures/top");
    expect(Object.fromEntries(urlOf(top).searchParams)).toEqual({
      metric: "fundingRate",
      baseAsset: "BTC",
      limit: "10",
    });

    const liq = mockFetch({ from: 1, to: 2, events: [] });
    vi.stubGlobal("fetch", liq);
    await keyed().futuresLiquidations({});
    expect(urlOf(liq).pathname).toBe("/api/v1/futures/liquidations");
    expect([...urlOf(liq).searchParams.keys()]).toEqual([]);
  });

  it("a 403 below Max passes through verbatim", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(
        { message: "Liquidation events are not included in the pro plan. Upgrade at https://blackforge.so/pricing." },
        { status: 403 },
      ),
    );
    const err = await keyed().futuresLiquidations({}).catch((e) => e);
    expect(err).toBeInstanceOf(BlackForgeApiError);
    expect(err.status).toBe(403);
    expect(err.message).toContain("https://blackforge.so/pricing");
  });

  it("every futures route fails fast without a key", async () => {
    const spy = mockFetch({});
    vi.stubGlobal("fetch", spy);
    const client = new BlackForgeClient({ baseUrl: "http://x/api", apiKey: "" });
    for (const call of [
      () => client.futuresSymbols("okx"),
      () => client.futuresLatest("binance", "BTCUSDT"),
      () => client.futuresTop({ metric: "fundingRate" }),
      () => client.futuresLiquidations({}),
    ]) {
      const err = await call().catch((e) => e);
      expect(err.message).toContain("BLACKFORGE_API_KEY");
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("futures shapers", () => {
  it("catalog adds futuresMetricCount (sold only) and leaves the spot count alone", () => {
    const shaped = shapeCatalog(CATALOG) as Record<string, unknown>;
    expect(shaped.metricCount).toBe(1);
    expect(shaped.futuresMetricCount).toBe(3);
    expect(shaped.futures).toEqual(CATALOG.futures);
  });

  it("catalog without futures is exactly today's payload", () => {
    const spot = { venues: [], metrics: [] };
    expect(shapeCatalog(spot)).toEqual({ venues: [], metrics: [], metricCount: 0 });
  });

  it("the futures decode table is futures.qualityBits, never the spot bits", () => {
    expect(futuresBitsFromCatalog(CATALOG).map((b) => b.name)).toEqual(["QUOTE_MISSING", "TRADES_PARTIAL"]);
    expect(futuresBitsFromCatalog({ venues: [], metrics: [] })).toEqual([]);
  });

  it("latest keeps text values, adds tsIso, a futures quality note and columnsOmitted", () => {
    const shaped = shapeFuturesLatest(
      {
        ts: 1794614400000,
        interval: "1h",
        values: { baseAsset: "BTC", contractType: "perpetual", markPrice: 100000, liqLongCount: null },
        quality: { raw: 1, all: 1, flags: ["QUOTE_MISSING"], contaminates: ["price", "funding", "openInterest"] },
      },
      { rowsRemaining: 10, columnsOmitted: ["liqShortCount"] },
      { exchange: "binance", symbol: "BTCUSDT" },
    ) as Record<string, unknown>;
    expect(shaped).toMatchObject({
      exchange: "binance",
      symbol: "BTCUSDT",
      interval: "1h",
      tsIso: "2026-11-14T00:00:00.000Z",
      valueCount: 4,
      columnsOmitted: ["liqShortCount"],
    });
    expect((shaped.values as Record<string, unknown>).contractType).toBe("perpetual");
    expect(String(shaped.qualityNote)).toContain("QUOTE_MISSING");
    expect(String(shaped.qualityNote)).toContain("price, funding and openInterest");
  });

  it("an undecoded futures flag points at the futures table, not the spot one", () => {
    const note = qualityNote({ raw: 8, all: 8 }, "The futures `qualityBits` table in blackforge_catalog says what each flag means.");
    expect(note).toContain("futures `qualityBits`");
    expect(note).not.toContain("qualityFlags metric");
    // the spot default is unchanged
    expect(qualityNote({ raw: 8, all: 8 })).toContain("`bits` table on the qualityFlags metric");
  });

  it("latest with no row reads tsIso null", () => {
    const shaped = shapeFuturesLatest({ ts: 0, values: {} }, {}, { exchange: "okx", symbol: "X" }) as Record<string, unknown>;
    expect(shaped.tsIso).toBeNull();
    expect(shaped.valueCount).toBe(0);
    expect(shaped).not.toHaveProperty("qualityNote");
  });

  it("top spreads the payload and counts rows", () => {
    const shaped = shapeFuturesTop(
      {
        metric: "fundingRate",
        interval: "1h",
        ts: 1794614400000,
        order: "desc",
        rows: [{ exchange: "bybit", symbol: "BTCUSDT", baseAsset: "BTC", value: 0.0001 }],
      },
      {},
    ) as Record<string, unknown>;
    expect(shaped).toMatchObject({ metric: "fundingRate", order: "desc", rowCount: 1, tsIso: "2026-11-14T00:00:00.000Z" });
  });

  it("liquidations: ISO window, count, and a feed note naming only lower-bound venues present", () => {
    const events = [
      { ts: 1, exchange: "binance", symbol: "ETHUSDT", side: "long", price: 1, quantity: 1, notional: 1 },
      { ts: 2, exchange: "bybit", symbol: "BTCUSDT", side: "short", price: 1, quantity: 1, notional: 1 },
    ];
    const shaped = shapeFuturesLiquidations(
      { from: 1794610800000, to: 1794614400000, events, truncated: true },
      {},
      ["binance", "okx"],
    ) as Record<string, unknown>;
    expect(shaped).toMatchObject({
      fromIso: "2026-11-13T23:00:00.000Z",
      toIso: "2026-11-14T00:00:00.000Z",
      eventCount: 2,
      truncated: true,
    });
    expect(shaped.feedNote).toBe(
      "binance throttles its public liquidation feed, so in a cascade its events here are a lower bound.",
    );
    expect(liquidationFeedNote(events, ["okx"])).toBeUndefined();
    expect(liquidationFeedNote([...events, { ...events[0], exchange: "okx" }], ["binance", "okx"])).toBe(
      "binance and okx throttle their public liquidation feeds, so in a cascade their events here are a lower bound.",
    );
  });
});

describe("futures chart payload", () => {
  it("takes label, family and unit from futures.metrics; funding ratio travels as fraction", () => {
    expect(findFuturesMetric(CATALOG, "fundingRate")).toEqual({
      label: "Funding rate",
      unit: "fraction",
      family: "funding",
    });
    expect(findFuturesMetric(CATALOG, "markPrice")).toEqual({ label: "Mark price", unit: "price", family: "price" });
    expect(findFuturesMetric(CATALOG, "nope")).toBeUndefined();
    expect(findFuturesMetric(undefined, "fundingRate")).toBeUndefined();
  });

  it("forwards the FUTURES bit table so flagged buckets are drawn by futures family", () => {
    const payload = buildChartPayload({
      exchange: "bybit",
      symbol: "BTCUSDT",
      metric: "fundingRate",
      interval: "1h",
      points: [
        { ts: 1, value: 0.0001, quality: 0, qualityAll: 0 },
        { ts: 2, value: null, quality: 1, qualityAll: 1 },
      ],
      meta: findFuturesMetric(CATALOG, "fundingRate"),
      bits: futuresBitsFromCatalog(CATALOG),
      columnsOmitted: [],
    });
    expect(payload).toMatchObject({ v: 1, label: "Funding rate", unit: "fraction", family: "funding" });
    expect(payload.bits.map((b) => b.name)).toEqual(["QUOTE_MISSING", "TRADES_PARTIAL"]);
    expect(payload.points).toEqual([
      { t: 1, v: 0.0001, q: 0, qa: 0 },
      { t: 2, v: null, q: 1, qa: 1 },
    ]);
  });
});
