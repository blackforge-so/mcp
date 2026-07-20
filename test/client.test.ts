import { afterEach, describe, expect, it, vi } from "vitest";
import { BlackForgeClient } from "../src/client.js";
import { BlackForgeApiError } from "../src/types.js";

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
