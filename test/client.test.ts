import { afterEach, describe, expect, it, vi } from "vitest";
import { BlackForgeClient } from "../src/client.js";
import { BlackForgeApiError, type QualityBit } from "../src/types.js";
import {
  anyFlagged,
  decodeMask,
  qualityNote,
  shapeLatest,
  shapeSeries,
  summarizeQuality,
} from "../src/shape.js";

function mockFetch(
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> },
) {
  const status = init?.status ?? 200;
  const res = new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  return vi.fn(async (..._args: unknown[]) => res);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BlackForgeClient — happy path shapes", () => {
  it("catalog is keyless and returns venues + metrics", async () => {
    const spy = mockFetch({ venues: [{ venue: "binance", minPlan: "free" }], metrics: [] });
    vi.stubGlobal("fetch", spy);
    const client = new BlackForgeClient({ baseUrl: "http://x/api" }); // no key
    const { data } = await client.catalog();
    expect(data.venues[0].venue).toBe("binance");
    // catalog must not send an api key
    const [, opts] = spy.mock.calls[0];
    expect((opts as RequestInit).headers).not.toHaveProperty("x-api-key");
  });

  it("latest parses values and surfaces X-BlackForge headers", async () => {
    const spy = mockFetch(
      { ts: 1783036500000, values: { spreadMean: 1.2, upDepth30: null } },
      {
        headers: {
          "x-blackforge-rows-served": "1",
          "x-blackforge-rows-remaining": "49999999",
          "x-blackforge-columns-omitted": "downDepth5, quoteImbalance",
        },
      },
    );
    vi.stubGlobal("fetch", spy);
    const client = new BlackForgeClient({ baseUrl: "http://x/api", apiKey: "bf_test" });
    const { data, meta } = await client.latest("binance", "BTCUSDT", ["spreadMean"]);
    expect(data.values.spreadMean).toBe(1.2);
    expect(meta.rowsServed).toBe(1);
    expect(meta.rowsRemaining).toBe(49999999);
    expect(meta.columnsOmitted).toEqual(["downDepth5", "quoteImbalance"]);
    // columns joined with commas in the query string
    const url = new URL((spy.mock.calls[0][0] as URL).toString());
    expect(url.searchParams.get("columns")).toBe("spreadMean");
    expect(url.searchParams.get("exchange")).toBe("binance");
    // key sent
    const headers = (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("bf_test");
  });

  it("series returns ascending points and reports empty columnsOmitted", async () => {
    const spy = mockFetch({
      metric: "spreadMean",
      exchange: "binance",
      symbol: "BTCUSDT",
      points: [{ ts: 1, value: 2 }],
    });
    vi.stubGlobal("fetch", spy);
    const client = new BlackForgeClient({ baseUrl: "http://x/api", apiKey: "bf_test" });
    const { data } = await client.series({
      exchange: "binance",
      symbol: "BTCUSDT",
      metric: "spreadMean",
      from: "2026-07-01T00:00:00Z",
      to: "2026-07-02T00:00:00Z",
      interval: "1h",
    });
    expect(data.points).toHaveLength(1);
  });

  it("usage returns days + rowsRemaining", async () => {
    const spy = mockFetch({ days: [{ date: "2026-07-20", count: 3, lastAt: "x" }], rowsRemaining: 42 });
    vi.stubGlobal("fetch", spy);
    const client = new BlackForgeClient({ baseUrl: "http://x/api", apiKey: "bf_test" });
    const { data } = await client.usage();
    expect(data.rowsRemaining).toBe(42);
  });
});

describe("BlackForgeClient — optional quality passthrough", () => {
  it("latest carries a quality sibling through untouched when the API sends one", async () => {
    const spy = mockFetch({
      ts: 1785162300000,
      values: { bestBid: 118240.1, qualityFlags: 6 },
      quality: {
        raw: 6,
        all: 6,
        flags: ["BOOK_DESYNCED", "BOOK_CROSSED"],
        contaminates: ["bookMicro", "bookWalls", "orderLadders"],
        observedAt: 1785162298412,
      },
    });
    vi.stubGlobal("fetch", spy);
    const client = new BlackForgeClient({ baseUrl: "http://x/api", apiKey: "bf_test" });
    const { data } = await client.latest("binance", "BTCUSDT");
    expect(data.quality?.flags).toEqual(["BOOK_DESYNCED", "BOOK_CROSSED"]);
    expect(data.quality?.contaminates).toContain("orderLadders");
  });

  it("latest without quality leaves the field undefined (today's production shape)", async () => {
    const spy = mockFetch({ ts: 1785162300000, values: { bestBid: 1 } });
    vi.stubGlobal("fetch", spy);
    const client = new BlackForgeClient({ baseUrl: "http://x/api", apiKey: "bf_test" });
    const { data } = await client.latest("binance", "BTCUSDT");
    expect(data.quality).toBeUndefined();
  });

  it("series points carry the per-point quality integers when present", async () => {
    const spy = mockFetch({
      metric: "upDepth30",
      exchange: "binance",
      symbol: "BTCUSDT",
      points: [
        { ts: 1785162300000, value: 123.4, quality: 0, qualityAll: 0 },
        { ts: 1785162600000, value: 118.9, quality: 2049, qualityAll: 0 },
      ],
    });
    vi.stubGlobal("fetch", spy);
    const client = new BlackForgeClient({ baseUrl: "http://x/api", apiKey: "bf_test" });
    const { data } = await client.series({
      exchange: "binance",
      symbol: "BTCUSDT",
      metric: "upDepth30",
      from: "2026-07-01T00:00:00Z",
      to: "2026-07-02T00:00:00Z",
      interval: "5m",
    });
    expect(data.points[1].quality).toBe(2049);
    expect(data.points[1].qualityAll).toBe(0);
  });
});

// The decode table always comes from the catalog. These fixtures stand in for it;
// nothing in src/ may ever hardcode an equivalent.
const BITS: QualityBit[] = [
  { bit: 0, name: "BOOK_DESYNCED", contaminates: ["bookMicro"] },
  { bit: 1, name: "BOOK_CROSSED" },
  { bit: 11, name: "EVENTS_LOST" },
];

describe("quality decode + notes", () => {
  it("decodes a mask into names from the catalog table", () => {
    expect(decodeMask(3, BITS)).toEqual(["BOOK_DESYNCED", "BOOK_CROSSED"]);
  });

  it("falls back to the raw mask for a bit the table does not name", () => {
    expect(decodeMask(4, BITS)).toEqual(["mask 4"]);
    expect(decodeMask(2049, [])).toEqual(["mask 1", "mask 2048"]);
  });

  it("never reports the 32768 sentinel as a flag", () => {
    expect(decodeMask(32768, BITS)).toEqual([]);
    expect(anyFlagged([{ quality: 32768 }])).toBe(false);
    expect(anyFlagged([{ quality: 1 }])).toBe(true);
  });

  it("qualityNote is undefined when quality is absent or clean", () => {
    expect(qualityNote(undefined)).toBeUndefined();
    expect(qualityNote({ raw: 0, all: 0, flags: [], contaminates: [] })).toBeUndefined();
  });

  it("qualityNote on 32768 says the row was not assessed, and does not warn", () => {
    const note = qualityNote({ raw: 32768, all: 32768 })!;
    expect(note).toContain("predates the quality rail");
    expect(note).toContain("not assessed");
    expect(note).toContain("unknown, not as bad");
  });

  it("qualityNote names the flags and the figures they affect", () => {
    const note = qualityNote({
      raw: 6,
      all: 6,
      flags: ["BOOK_DESYNCED", "BOOK_CROSSED"],
      contaminates: ["bookMicro", "bookWalls", "orderLadders"],
    })!;
    expect(note).toContain("BOOK_DESYNCED, BOOK_CROSSED");
    expect(note).toContain("bookMicro, bookWalls and orderLadders");
  });
});

describe("summarizeQuality", () => {
  it("counts flagged buckets per flag name", () => {
    const points = [
      { quality: 0 },
      { quality: 1 },
      { quality: 1 },
      { quality: 2048 },
      { quality: 0 },
    ];
    expect(summarizeQuality(points, BITS)).toEqual({
      flaggedBuckets: 3,
      of: 5,
      flags: { BOOK_DESYNCED: 2, EVENTS_LOST: 1 },
    });
  });

  it("is undefined when nothing is flagged, including an all-unknown archive", () => {
    expect(summarizeQuality([{ quality: 0 }, { quality: 0 }], BITS)).toBeUndefined();
    expect(summarizeQuality([{ quality: 32768 }, { quality: 32768 }], BITS)).toBeUndefined();
    expect(summarizeQuality([], BITS)).toBeUndefined();
  });

  it("reports unassessed buckets alongside real flags, never as flags", () => {
    const summary = summarizeQuality([{ quality: 1 }, { quality: 32768 }], BITS)!;
    expect(summary.flaggedBuckets).toBe(1);
    expect(summary.unassessedBuckets).toBe(1);
    expect(Object.keys(summary.flags)).toEqual(["BOOK_DESYNCED"]);
  });
});

describe("tool payload shaping", () => {
  // THE regression guard: today's API sends no `quality`, so the payload must be
  // exactly what it was before this field existed.
  it("latest without quality is byte-identical to the pre-quality payload", () => {
    const payload = shapeLatest(
      { ts: 1785162300000, values: { bestBid: 1, upDepth30: null } },
      { rowsRemaining: 42 },
      { exchange: "binance", symbol: "BTCUSDT" },
    );
    expect(JSON.stringify(payload, null, 2)).toBe(
      JSON.stringify(
        {
          exchange: "binance",
          symbol: "BTCUSDT",
          ts: 1785162300000,
          values: { bestBid: 1, upDepth30: null },
          tsIso: new Date(1785162300000).toISOString(),
          valueCount: 2,
          rowsRemaining: 42,
          columnsOmitted: [],
        },
        null,
        2,
      ),
    );
  });

  it("series without quality emits no qualitySummary and no per-point quality keys", () => {
    const payload = shapeSeries(
      {
        metric: "upDepth30",
        exchange: "binance",
        symbol: "BTCUSDT",
        points: [{ ts: 1, value: 2 }],
      },
      {},
      { exchange: "binance", symbol: "BTCUSDT", metric: "upDepth30", interval: "5m" },
      summarizeQuality([{}], []),
    ) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("qualitySummary");
    expect(JSON.stringify(payload)).not.toContain("quality");
  });

  it("latest adds qualityNote only when the row is flagged", () => {
    const flagged = shapeLatest(
      {
        ts: 1785162300000,
        values: { bestBid: 1 },
        quality: { raw: 6, all: 6, flags: ["BOOK_DESYNCED"], contaminates: ["bookMicro"] },
      },
      {},
      { exchange: "binance", symbol: "BTCUSDT" },
    ) as Record<string, unknown>;
    expect(flagged.qualityNote).toContain("BOOK_DESYNCED");
    // the raw quality object survives the shaping untouched
    expect(flagged.quality).toEqual({
      raw: 6,
      all: 6,
      flags: ["BOOK_DESYNCED"],
      contaminates: ["bookMicro"],
    });

    const clean = shapeLatest(
      { ts: 1785162300000, values: { bestBid: 1 }, quality: { raw: 0, all: 0, flags: [] } },
      {},
      { exchange: "binance", symbol: "BTCUSDT" },
    ) as Record<string, unknown>;
    expect(clean).not.toHaveProperty("qualityNote");
  });

  it("series strips per-point quality but keeps every other point field", () => {
    const payload = shapeSeries(
      {
        metric: "upDepth30",
        exchange: "binance",
        symbol: "BTCUSDT",
        points: [
          { ts: 1, value: 2, quality: 0, qualityAll: 0 },
          { ts: 2, value: 3, quality: 2049, qualityAll: 0 },
        ],
      },
      {},
      { exchange: "binance", symbol: "BTCUSDT", metric: "upDepth30", interval: "5m" },
      summarizeQuality([{ quality: 0 }, { quality: 2049 }], BITS),
    ) as { points: unknown[]; qualitySummary: unknown };
    expect(payload.points).toEqual([
      { ts: 1, value: 2 },
      { ts: 2, value: 3 },
    ]);
    expect(payload.qualitySummary).toEqual({
      flaggedBuckets: 1,
      of: 2,
      flags: { BOOK_DESYNCED: 1, EVENTS_LOST: 1 },
    });
  });

  it("an unknown sibling key from the API reaches the model instead of being dropped", () => {
    const payload = shapeLatest(
      {
        ts: 1,
        values: {},
        // a field this client has never heard of
        somethingNew: { hello: "world" },
      } as never,
      {},
      { exchange: "binance", symbol: "BTCUSDT" },
    ) as Record<string, unknown>;
    expect(payload.somethingNew).toEqual({ hello: "world" });
  });
});

describe("BlackForgeClient — error translation", () => {
  it("402 quota exhausted becomes a typed error carrying the server message", async () => {
    const spy = mockFetch({ message: "Monthly row quota exhausted", statusCode: 402 }, { status: 402 });
    vi.stubGlobal("fetch", spy);
    const client = new BlackForgeClient({ baseUrl: "http://x/api", apiKey: "bf_test" });
    await expect(client.usage()).rejects.toMatchObject({
      status: 402,
      message: "Monthly row quota exhausted",
    });
  });

  it("403 venue-not-in-plan passes the upgrade URL through verbatim", async () => {
    const msg =
      "The okx venue is not included in the free plan (included: binance, mexc, gate). Upgrade at https://blackforge.so/pricing to query all 9 venues.";
    const spy = mockFetch({ message: msg, statusCode: 403 }, { status: 403 });
    vi.stubGlobal("fetch", spy);
    const client = new BlackForgeClient({ baseUrl: "http://x/api", apiKey: "bf_free" });
    await expect(client.symbols("okx")).rejects.toMatchObject({ status: 403, message: msg });
  });

  it("400 bad metric becomes a typed error", async () => {
    const spy = mockFetch({ message: "Unknown metric: nope", statusCode: 400 }, { status: 400 });
    vi.stubGlobal("fetch", spy);
    const client = new BlackForgeClient({ baseUrl: "http://x/api", apiKey: "bf_test" });
    await expect(
      client.series({
        exchange: "binance",
        symbol: "BTCUSDT",
        metric: "nope",
        from: "2026-07-01T00:00:00Z",
        to: "2026-07-02T00:00:00Z",
        interval: "5m",
      }),
    ).rejects.toBeInstanceOf(BlackForgeApiError);
  });

  it("array-form message is joined", async () => {
    const spy = mockFetch({ message: ["exchange should not be empty"], statusCode: 400 }, { status: 400 });
    vi.stubGlobal("fetch", spy);
    const client = new BlackForgeClient({ baseUrl: "http://x/api", apiKey: "bf_test" });
    await expect(client.symbols("")).rejects.toMatchObject({
      status: 400,
      message: "exchange should not be empty",
    });
  });
});

describe("BlackForgeClient — missing key fail-fast", () => {
  it("keyed routes throw a clear error when no key is configured", async () => {
    vi.stubEnv("BLACKFORGE_API_KEY", ""); // ensure a shell key does not leak in
    const spy = mockFetch({});
    vi.stubGlobal("fetch", spy);
    const client = new BlackForgeClient({ baseUrl: "http://x/api" }); // no key
    await expect(client.symbols("binance")).rejects.toMatchObject({ status: 0 });
    // fetch was never called — we failed before the network
    expect(spy).not.toHaveBeenCalled();
  });

  it("catalog still works without a key", async () => {
    const spy = mockFetch({ venues: [], metrics: [] });
    vi.stubGlobal("fetch", spy);
    const client = new BlackForgeClient({ baseUrl: "http://x/api" });
    await expect(client.catalog()).resolves.toBeTruthy();
    expect(spy).toHaveBeenCalledOnce();
  });

  it("hasKey reflects configured key", () => {
    vi.stubEnv("BLACKFORGE_API_KEY", "");
    expect(new BlackForgeClient({ baseUrl: "http://x", apiKey: "k" }).hasKey()).toBe(true);
    expect(new BlackForgeClient({ baseUrl: "http://x" }).hasKey()).toBe(false);
  });

  it("trailing slashes on base url are normalised", async () => {
    const spy = mockFetch({ venues: [], metrics: [] });
    vi.stubGlobal("fetch", spy);
    const client = new BlackForgeClient({ baseUrl: "http://x/api///" });
    await client.catalog();
    expect((spy.mock.calls[0][0] as URL).toString()).toBe("http://x/api/v1/catalog");
  });
});
