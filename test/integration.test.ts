// Spawns the BUILT server (dist/index.js) as a child process over stdio and
// drives it with the real MCP client. Requires the local BlackForge API dev
// server at http://localhost:3001/api with the seeded `max` demo key.
//
// If the local API is not reachable, the data-dependent assertions are skipped
// (the tool-listing / keyless-catalog assertions still run against the server).

import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distEntry = path.resolve(__dirname, "../dist/index.js");
const BASE_URL = "http://localhost:3001/api";
const MAX_KEY = "bf_demoMaxKey_0000000000000000";
const FREE_KEY = "bf_freeSeedKey_0000000000000000";

async function localApiUp(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/v1/catalog`);
    return res.ok;
  } catch {
    return false;
  }
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
}

async function makeClient(apiKey: string | undefined) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [distEntry],
    env: {
      PATH: process.env.PATH ?? "",
      BLACKFORGE_BASE_URL: BASE_URL,
      ...(apiKey ? { BLACKFORGE_API_KEY: apiKey } : {}),
    },
  });
  const client = new Client({ name: "blackforge-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

describe("stdio integration", () => {
  let apiUp = false;

  beforeAll(async () => {
    if (!existsSync(distEntry)) throw new Error("dist/index.js missing — run `npm run build` first");
    apiUp = await localApiUp();
  });

  it("lists all five tools", async () => {
    const client = await makeClient(MAX_KEY);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "blackforge_catalog",
        "blackforge_latest",
        "blackforge_series",
        "blackforge_symbols",
        "blackforge_usage",
      ]);
    } finally {
      await client.close();
    }
  });

  it("blackforge_catalog returns 9 venues keyless (no API key set)", async () => {
    if (!apiUp) return; // needs the local API
    const client = await makeClient(undefined); // no key at all
    try {
      const res = (await client.callTool({ name: "blackforge_catalog", arguments: {} })) as {
        content: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse(textOf(res));
      expect(parsed.venues).toHaveLength(9);
      expect(parsed.metricCount).toBeGreaterThan(90);
    } finally {
      await client.close();
    }
  });

  it("blackforge_latest for binance/BTCUSDT (max key) returns a values object", async () => {
    if (!apiUp) return;
    const client = await makeClient(MAX_KEY);
    try {
      const res = (await client.callTool({
        name: "blackforge_latest",
        arguments: { exchange: "binance", symbol: "BTCUSDT" },
      })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse(textOf(res));
      expect(parsed.values).toBeTypeOf("object");
      expect(parsed.valueCount).toBeGreaterThan(10);
      expect(parsed.ts).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it("blackforge_symbols (max key) proves multi-venue: okx has symbols", async () => {
    if (!apiUp) return;
    const client = await makeClient(MAX_KEY);
    try {
      const res = (await client.callTool({
        name: "blackforge_symbols",
        arguments: { exchange: "okx" },
      })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse(textOf(res));
      expect(Array.isArray(parsed.symbols)).toBe(true);
      expect(parsed.count).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it("403 passthrough: free key hitting okx returns a tool error with the upgrade URL", async () => {
    if (!apiUp) return;
    const client = await makeClient(FREE_KEY);
    try {
      const res = (await client.callTool({
        name: "blackforge_symbols",
        arguments: { exchange: "okx" },
      })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
      expect(res.isError).toBe(true);
      const text = textOf(res);
      expect(text).toContain("403");
      expect(text).toContain("blackforge.so/pricing");
    } finally {
      await client.close();
    }
  });

  it("keyed tool without a key returns a clear tool error; catalog still works", async () => {
    const client = await makeClient(undefined); // no key
    try {
      const res = (await client.callTool({
        name: "blackforge_usage",
        arguments: {},
      })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain("BLACKFORGE_API_KEY");
    } finally {
      await client.close();
    }
  });
});

// ── the quality surface, against a stub API ─────────────────────────────────
// These run everywhere: a tiny in-process HTTP server stands in for /v1, so the
// end-to-end tool payloads are asserted without a local BlackForge stack. The
// first test is the one that matters most — today's API sends no `quality`, and
// the tool output must be exactly what it was before the field existed.

interface StubBodies {
  latest?: unknown;
  series?: unknown;
  catalog?: unknown;
}

async function withStubApi(
  bodies: StubBodies,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const catalog = bodies.catalog ?? {
    venues: [],
    metrics: [
      {
        key: "qualityFlags",
        label: "Quality flags",
        family: "quality",
        unit: "bitmask",
        quoteRelative: false,
        nullable: false,
        description: "",
        howToRead: "",
        minPlan: "free",
        bits: [
          { bit: 0, name: "BOOK_DESYNCED" },
          { bit: 11, name: "EVENTS_LOST" },
        ],
      },
    ],
  };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const body =
      url.pathname.endsWith("/v1/latest")
        ? bodies.latest
        : url.pathname.endsWith("/v1/series")
          ? bodies.series
          : catalog;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [distEntry],
    env: {
      PATH: process.env.PATH ?? "",
      BLACKFORGE_BASE_URL: `http://127.0.0.1:${port}/api`,
      BLACKFORGE_API_KEY: MAX_KEY,
    },
  });
  const client = new Client({ name: "blackforge-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  expect(res.isError).toBeFalsy();
  return JSON.parse(textOf(res)) as Record<string, unknown>;
}

const LATEST_ARGS = { exchange: "binance", symbol: "BTCUSDT" };
const SERIES_ARGS = {
  exchange: "binance",
  symbol: "BTCUSDT",
  metric: "upDepth30",
  from: "2026-07-01T00:00:00Z",
  to: "2026-07-01T01:00:00Z",
  interval: "5m",
};

describe("quality surface (stub API)", () => {
  it("no quality on the wire → the payload is exactly today's", async () => {
    await withStubApi(
      {
        latest: { ts: 1785162300000, values: { bestBid: 118240.1 } },
        series: {
          metric: "upDepth30",
          exchange: "binance",
          symbol: "BTCUSDT",
          points: [{ ts: 1785162300000, value: 123.4 }],
        },
      },
      async (client) => {
        const latest = await call(client, "blackforge_latest", LATEST_ARGS);
        expect(latest).not.toHaveProperty("quality");
        expect(latest).not.toHaveProperty("qualityNote");
        expect(latest.values).toEqual({ bestBid: 118240.1 });

        const series = await call(client, "blackforge_series", SERIES_ARGS);
        expect(series).not.toHaveProperty("qualitySummary");
        expect(series.points).toEqual([{ ts: 1785162300000, value: 123.4 }]);
      },
    );
  });

  it("a flagged latest row carries quality through and adds a readable note", async () => {
    await withStubApi(
      {
        latest: {
          ts: 1785162300000,
          values: { bestBid: 118240.1, qualityFlags: 6 },
          quality: {
            raw: 6,
            all: 6,
            flags: ["BOOK_DESYNCED", "BOOK_CROSSED"],
            contaminates: ["bookMicro", "bookWalls", "orderLadders"],
            observedAt: 1785162298412,
          },
        },
      },
      async (client) => {
        const latest = await call(client, "blackforge_latest", LATEST_ARGS);
        expect(latest.quality).toMatchObject({ raw: 6, flags: ["BOOK_DESYNCED", "BOOK_CROSSED"] });
        expect(String(latest.qualityNote)).toContain("BOOK_DESYNCED");
        expect(String(latest.qualityNote)).toContain("orderLadders");
      },
    );
  });

  it("a 32768 row reads as unassessed, not as a warning", async () => {
    await withStubApi(
      {
        latest: {
          ts: 1785162300000,
          values: { bestBid: 1 },
          quality: { raw: 32768, all: 32768, flags: [], contaminates: [] },
        },
      },
      async (client) => {
        const latest = await call(client, "blackforge_latest", LATEST_ARGS);
        expect(String(latest.qualityNote)).toContain("predates the quality rail");
        expect(String(latest.qualityNote)).toContain("unknown, not as bad");
      },
    );
  });

  it("series aggregates per-point quality using the catalog bit names, and drops it from points", async () => {
    await withStubApi(
      {
        series: {
          metric: "upDepth30",
          exchange: "binance",
          symbol: "BTCUSDT",
          points: [
            { ts: 1, value: 1, quality: 0, qualityAll: 0 },
            { ts: 2, value: 2, quality: 1, qualityAll: 0 },
            { ts: 3, value: 3, quality: 2048, qualityAll: 0 },
          ],
        },
      },
      async (client) => {
        const series = await call(client, "blackforge_series", SERIES_ARGS);
        expect(series.qualitySummary).toEqual({
          flaggedBuckets: 2,
          of: 3,
          flags: { BOOK_DESYNCED: 1, EVENTS_LOST: 1 },
        });
        expect(series.points).toEqual([
          { ts: 1, value: 1 },
          { ts: 2, value: 2 },
          { ts: 3, value: 3 },
        ]);
      },
    );
  });

  it("a new sibling key on the catalog reaches the model (no key allowlist)", async () => {
    await withStubApi(
      { catalog: { venues: [], metrics: [], somethingNew: { hello: "world" } } },
      async (client) => {
        const catalog = await call(client, "blackforge_catalog", {});
        expect(catalog.somethingNew).toEqual({ hello: "world" });
        expect(catalog.metricCount).toBe(0);
      },
    );
  });
});
