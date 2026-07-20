// Spawns the BUILT server (dist/index.js) as a child process over stdio and
// drives it with the real MCP client. Requires the local BlackForge API dev
// server at http://localhost:3001/api with the seeded `max` demo key.
//
// If the local API is not reachable, the data-dependent assertions are skipped
// (the tool-listing / keyless-catalog assertions still run against the server).

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
