// The BUILT server over stdio, against a fake API + relay on one local port.
// Proves the realtime tools end to end through the real MCP client: tool
// metadata (annotations, copy rules), the watch stream, verbatim formula
// errors, and the plan refusal text.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startFakeRealtime, type FakeRealtime } from "./fake-realtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distEntry = path.resolve(__dirname, "../dist/index.js");
const KEY = "bf_stdio_realtime";

type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };
const textOf = (r: ToolResult) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

let fake: FakeRealtime;
let client: Client;

beforeAll(async () => {
  if (!existsSync(distEntry)) throw new Error("dist/index.js missing: run `npm run build` first");
  fake = await startFakeRealtime(
    ({ method, path, body }) => {
      if (path === "/api/v1/formulas/validate") {
        const expr = (body as { expr: string }).expr;
        return expr.includes("okx:BTCUSDT")
          ? {
              status: 400,
              body: {
                error: {
                  code: "unknown_symbol",
                  message: "okx has no pair BTCUSDT. okx spells pairs with a dash.",
                  at: { offset: 4, line: 1, column: 5, length: 11 },
                  source: expr,
                  pointer: "    ^^^^^^^^^^^",
                  suggestions: ["okx:BTC-USDT"],
                  expected: null,
                  docs: "https://blackforge.so/docs/formulas#pairs",
                },
              },
            }
          : { status: 200, body: { ok: true, normalised: expr, pairs: [], primitives: [], horizonSeconds: 0, cost: { rowsPerEvaluation: 1, rowsPer30Days: 2592000 } } };
      }
      if (method === "POST" && path === "/api/v1/formulas") return { status: 201, body: { formula: { id: "fml_eph", ...(body as object) } } };
      if (method === "GET" && path === "/api/v1/formulas/fml_saved") return { status: 200, body: { formula: { id: "fml_saved" }, live: false } };
      if (method === "GET" && path === "/api/v1/alerts") return { status: 403, body: { error: { code: "plan_required", plan: "ultra", upgrade: "https://blackforge.so/pricing" } } };
      if (path === "/v1/book/binance/BTCUSDT") return { status: 200, body: { exchange: "binance", symbol: "BTCUSDT", bids: [[1, 1]], asks: [[2, 1]], rowsCharged: 2 } };
      return undefined;
    },
    (conn, msg) => {
      if (msg?.op === "subscribe") {
        conn.send({ type: "subscribed", id: msg.id, formula: msg.formula, interval: 1, horizonSeconds: 0, warmUntil: 0 });
        conn.send({ type: "value", formula: msg.formula, ts: 1000, value: 2, flags: 0 });
        conn.send({ type: "value", formula: msg.formula, ts: 2000, value: 4, flags: 0 });
      }
    },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [distEntry],
    env: {
      PATH: process.env.PATH ?? "",
      BLACKFORGE_BASE_URL: `${fake.url}/api`,
      BLACKFORGE_REALTIME_URL: fake.url,
      BLACKFORGE_API_KEY: KEY,
    },
  });
  client = new Client({ name: "blackforge-test", version: "0.0.0" });
  await client.connect(transport);
});

afterAll(async () => {
  await client?.close();
  await fake?.close();
});

describe("realtime tools over stdio (stub API + relay)", () => {
  it("annotations: reads are read-only, deletes are destructive, every tool is open-world", async () => {
    const { tools } = await client.listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const n of ["blackforge_formula_validate", "blackforge_formula_list", "blackforge_formula_watch", "blackforge_book", "blackforge_fill", "blackforge_spread_map", "blackforge_alert_list", "blackforge_catalog", "blackforge_series"]) {
      expect(by[n].annotations?.readOnlyHint, n).toBe(true);
    }
    for (const n of ["blackforge_formula_delete", "blackforge_alert_delete"]) {
      expect(by[n].annotations?.destructiveHint, n).toBe(true);
      expect(by[n].annotations?.readOnlyHint, n).toBe(false);
    }
    for (const n of ["blackforge_formula_create", "blackforge_alert_create"]) {
      expect(by[n].annotations?.readOnlyHint, n).toBe(false);
      expect(by[n].annotations?.destructiveHint, n).toBe(false);
    }
    for (const t of tools) expect(t.annotations?.openWorldHint, t.name).toBe(true);
  });

  it("copy rules: no em dash and no banned words in any tool description", async () => {
    const { tools } = await client.listTools();
    for (const t of tools) {
      const all = JSON.stringify({ d: t.description, s: t.inputSchema, a: t.annotations, title: t.title });
      expect(all, t.name).not.toContain("—");
      expect(all.toLowerCase(), t.name).not.toMatch(/\bsignals?\b|\bpumps?\b|anomal|probabilit|trade call/);
    }
  });

  it("watch with expr saves a one-hour formula, streams it, and summarises the series", async () => {
    const res = (await client.callTool({
      name: "blackforge_formula_watch",
      arguments: { expr: "mid(binance:BTCUSDT)", seconds: 1 },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    const out = JSON.parse(textOf(res));
    expect(out.formula).toBe("fml_eph");
    expect(out.createdEphemeral.id).toBe("fml_eph");
    expect(out.samples).toBe(2);
    expect(out.first).toEqual({ ts: 1000, value: 2 });
    expect(out.max).toEqual({ ts: 2000, value: 4 });
    expect(out.series).toEqual([{ ts: 1000, value: 2 }, { ts: 2000, value: 4 }]);
    const created = fake.requests.find((r) => r.method === "POST" && r.path === "/api/v1/formulas");
    expect(created?.body).toMatchObject({ expr: "mid(binance:BTCUSDT)", ephemeral: true });
    const conn = fake.wsConns.at(-1)!;
    expect(conn.headers["x-api-key"]).toBe(KEY);
  });

  it("watch with a saved formulaId preflights it on the API, then streams", async () => {
    const res = (await client.callTool({ name: "blackforge_formula_watch", arguments: { formulaId: "fml_saved", seconds: 1 } })) as ToolResult;
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(textOf(res)).samples).toBe(2);
  });

  it("watch refuses both or neither of formulaId and expr", async () => {
    const res = (await client.callTool({ name: "blackforge_formula_watch", arguments: {} })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("exactly one of formulaId or expr");
  });

  it("validate returns a refusal verbatim as data the model can act on", async () => {
    const res = (await client.callTool({ name: "blackforge_formula_validate", arguments: { expr: "mid(okx:BTCUSDT)" } })) as ToolResult;
    expect(res.isError).toBeFalsy();
    const out = JSON.parse(textOf(res));
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("unknown_symbol");
    expect(out.error.suggestions).toEqual(["okx:BTC-USDT"]);
    expect(out.error.pointer).toBe("    ^^^^^^^^^^^");
  });

  it("a plan refusal is a tool error that names Ultra and the upgrade URL", async () => {
    const res = (await client.callTool({ name: "blackforge_alert_list", arguments: {} })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("HTTP 403");
    expect(textOf(res)).toContain("Ultra");
    expect(textOf(res)).toContain("https://blackforge.so/pricing");
  });

  it("book reads the relay", async () => {
    const res = (await client.callTool({ name: "blackforge_book", arguments: { exchange: "binance", symbol: "BTCUSDT", levels: 1 } })) as ToolResult;
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(textOf(res)).rowsCharged).toBe(2);
  });

  it("fill needs exactly one of usd or size", async () => {
    const res = (await client.callTool({ name: "blackforge_fill", arguments: { exchange: "binance", symbol: "BTCUSDT", side: "buy" } })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("exactly one of usd or size");
  });
});
