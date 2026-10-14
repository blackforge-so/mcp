import { afterEach, describe, expect, it } from "vitest";
import {
  RealtimeApiError,
  RealtimeClient,
  decodeValueFlags,
  summarizeWatch,
  toRealtimeError,
} from "../src/realtime.js";
import { startFakeRealtime, type FakeRealtime, type HttpHandler, type WsHandler } from "./fake-realtime.js";

const KEY = "bf_test_realtime";

const FORMULA_ERROR = {
  code: "unknown_symbol",
  message: "okx has no pair BTCUSDT. okx spells pairs with a dash.",
  at: { offset: 4, line: 1, column: 5, length: 11 },
  source: "mid(okx:BTCUSDT) - mid(binance:BTCUSDT)",
  pointer: "    ^^^^^^^^^^^",
  suggestions: ["okx:BTC-USDT", "okx:BTC-USDC"],
  expected: null,
  docs: "https://blackforge.so/docs/formulas#pairs",
};

const PLAN_REQUIRED = { error: { code: "plan_required", plan: "ultra", upgrade: "https://blackforge.so/pricing" } };

let fake: FakeRealtime | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function client(http: HttpHandler, ws?: WsHandler, opts?: { rejectWs?: number }) {
  fake = await startFakeRealtime(http, ws, opts);
  return new RealtimeClient({ baseUrl: fake.url + "/api", realtimeUrl: fake.url, apiKey: KEY });
}

describe("formulas on the API", () => {
  it("validate: success is { ok: true, ... } and sends the key in a header, never the URL", async () => {
    const rt = await client(({ path, body }) =>
      path === "/api/v1/formulas/validate"
        ? {
            status: 200,
            body: {
              ok: true,
              normalised: "mid(binance:BTCUSDT)",
              pairs: ["binance:BTCUSDT"],
              primitives: ["mid"],
              horizonSeconds: 0,
              cost: { rowsPerEvaluation: 1, rowsPer30Days: 2592000 },
              echo: body,
            },
          }
        : undefined,
    );
    const out = await rt.validate("mid(binance:BTCUSDT)", 5);
    expect(out.ok).toBe(true);
    expect(out.cost).toEqual({ rowsPerEvaluation: 1, rowsPer30Days: 2592000 });
    expect(out.echo).toEqual({ expr: "mid(binance:BTCUSDT)", interval: 5 });
    const req = fake!.requests[0];
    expect(req.method).toBe("POST");
    expect(req.headers["x-api-key"]).toBe(KEY);
    expect(req.path).not.toContain(KEY);
  });

  it("validate: a located 400 comes back verbatim as { ok: false, error }, not thrown", async () => {
    const rt = await client(() => ({ status: 400, body: { error: FORMULA_ERROR } }));
    const out = await rt.validate("mid(okx:BTCUSDT) - mid(binance:BTCUSDT)");
    expect(out).toEqual({ ok: false, error: FORMULA_ERROR });
  });

  it("create: a 400 throws with the server's code, pointer and suggestions in the message", async () => {
    const rt = await client(() => ({ status: 400, body: { error: FORMULA_ERROR } }));
    const err = (await rt.createFormula({ name: "x", expr: FORMULA_ERROR.source }).catch((e) => e)) as RealtimeApiError;
    expect(err).toBeInstanceOf(RealtimeApiError);
    expect(err.status).toBe(400);
    expect(err.code).toBe("unknown_symbol");
    expect(err.formulaError).toEqual(FORMULA_ERROR);
    expect(err.message).toContain("unknown_symbol");
    expect(err.message).toContain("    ^^^^^^^^^^^");
    expect(err.message).toContain("okx:BTC-USDT");
    // the raw object is appended verbatim
    expect(JSON.parse(err.message.slice(err.message.indexOf("{")))).toEqual({ error: FORMULA_ERROR });
  });

  it("a 403 plan_required on a formula route names Ultra and the upgrade URL", async () => {
    const rt = await client(() => ({ status: 403, body: PLAN_REQUIRED }));
    const err = (await rt.listFormulas().catch((e) => e)) as RealtimeApiError;
    expect(err.status).toBe(403);
    expect(err.message).toContain("Ultra");
    expect(err.message).toContain("https://blackforge.so/pricing");
    expect(err.message).not.toMatch(/—/);
  });

  it("create sends the body; delete reports the notifications deleted with it", async () => {
    const rt = await client(({ method, path, body }) => {
      if (method === "POST" && path === "/api/v1/formulas") return { status: 201, body: { formula: { id: "fml_1", ...(body as object) } } };
      if (method === "DELETE" && path === "/api/v1/formulas/fml_1")
        return { status: 204, headers: { "x-blackforge-deleted-alerts": "alr_a, alr_b" } };
      return undefined;
    });
    const created = await rt.createFormula({ name: "basis", expr: "mid(binance:BTCUSDT)", interval: 2 });
    expect(created.formula).toMatchObject({ id: "fml_1", name: "basis", interval: 2 });
    expect(await rt.deleteFormula("fml_1")).toEqual({ deleted: "fml_1", deletedAlerts: ["alr_a", "alr_b"] });
  });

  it("alerts: create drops undefined fields and passes webhookSecret through; list and delete", async () => {
    const rt = await client(({ method, path, body }) => {
      if (method === "POST" && path === "/api/v1/alerts")
        return { status: 201, body: { alert: { id: "alr_1", ...(body as object) }, webhookSecret: "whsec_once" } };
      if (method === "GET" && path === "/api/v1/alerts") return { status: 200, body: { alerts: [{ id: "alr_1" }], limits: { alerts: 10 } } };
      if (method === "DELETE" && path === "/api/v1/alerts/alr_1") return { status: 204 };
      return undefined;
    });
    const a = await rt.createAlert({ formulaId: "fml_1", direction: "above", threshold: 50, webhookUrl: "https://example.com/h" });
    expect(a.webhookSecret).toBe("whsec_once");
    expect(fake!.requests[0].body).toEqual({ formulaId: "fml_1", direction: "above", threshold: 50, webhookUrl: "https://example.com/h" });
    expect((await rt.listAlerts()).alerts).toHaveLength(1);
    expect(await rt.deleteAlert("alr_1")).toEqual({ deleted: "alr_1" });
  });

  it("realtime_disabled 503 reads as switched off", async () => {
    const rt = await client(() => ({ status: 503, body: { error: { code: "realtime_disabled" } } }));
    const err = (await rt.listAlerts().catch((e) => e)) as RealtimeApiError;
    expect(err.status).toBe(503);
    expect(err.message).toContain("switched off");
  });

  it("no key: fails before the network with the env var named", async () => {
    const rt = new RealtimeClient({ baseUrl: "http://127.0.0.1:1", realtimeUrl: "http://127.0.0.1:1", apiKey: "" });
    await expect(rt.listFormulas()).rejects.toThrow(/BLACKFORGE_API_KEY/);
  });
});

describe("live snapshot reads on the relay", () => {
  it("book, fill and spread-map hit the relay paths with the key and the query", async () => {
    const rt = await client(({ path, query }) => {
      if (path === "/v1/book/binance/BTCUSDT")
        return { status: 200, body: { exchange: "binance", symbol: "BTCUSDT", levels: query.get("levels"), bids: [[1, 2]], asks: [[3, 4]], rowsCharged: 4 } };
      if (path === "/v1/fill/okx/BTC-USDT")
        return { status: 200, body: { fill: { side: query.get("side"), usd: query.get("usd"), size: query.get("size"), complete: true, bps: 0.6 } } };
      if (path === "/v1/spread-map") return { status: 200, body: { base: query.get("base"), quote: query.get("quote"), venues: [] } };
      return undefined;
    });
    const book = await rt.book("binance", "BTCUSDT", 2);
    expect(book).toMatchObject({ levels: "2", rowsCharged: 4 });
    const fill = await rt.fill({ exchange: "okx", symbol: "BTC-USDT", side: "buy", usd: 50000 });
    expect(fill.fill).toMatchObject({ side: "buy", usd: "50000", size: null });
    expect(await rt.spreadMap("BTC", "USDT")).toMatchObject({ base: "BTC", quote: "USDT" });
    for (const r of fake!.requests) {
      expect(r.headers["x-api-key"]).toBe(KEY);
      expect(r.path.startsWith("/api")).toBe(false);
    }
  });

  it("collector-style string errors are explained (unknown symbol, budget, not owned)", async () => {
    let next: { status: number; body: unknown } = { status: 404, body: { error: "unknown-symbol" } };
    const rt = await client(() => next);
    let err = (await rt.book("okx", "BTCUSDT").catch((e) => e)) as RealtimeApiError;
    expect(err.message).toContain("okx has no live pair BTCUSDT");
    next = { status: 429, body: { error: "budget", retryAfterMs: 2500 } };
    err = (await rt.book("okx", "BTC-USDT").catch((e) => e)) as RealtimeApiError;
    expect(err.message).toContain("Retry in 3 s");
    next = { status: 409, body: { error: "not-owned", owner: "x" } };
    err = (await rt.book("okx", "BTC-USDT").catch((e) => e)) as RealtimeApiError;
    expect(err.message).toContain("Retry in a few seconds");
  });

  it("a 403 plan_required on a snapshot route names Max or Ultra", async () => {
    const rt = await client(() => ({ status: 403, body: { error: { code: "plan_required", plan: "max" } } }));
    const err = (await rt.spreadMap("BTC", "USDT").catch((e) => e)) as RealtimeApiError;
    expect(err.message).toContain("Max or Ultra");
  });
});

describe("the stream", () => {
  const relay: WsHandler = (conn, msg) => {
    if (msg === null) {
      conn.send({ type: "hello", connection: "cn_1", plan: "ultra", limits: {}, serverTime: 1 });
      return;
    }
    if (msg.op === "subscribe") {
      conn.send({ type: "subscribed", id: msg.id, formula: msg.formula, interval: 1, horizonSeconds: 60, warmUntil: 5000, replayed: 0 });
      conn.send({ type: "value", formula: msg.formula, ts: 1000, value: 41.5, flags: 1, why: ["WARMING"] });
      conn.send({ type: "value", formula: "fml_other", ts: 1000, value: 999, flags: 0 });
      conn.send({ type: "value", formula: msg.formula, ts: 2000, value: null, flags: 80 });
      conn.send({ type: "value", formula: msg.formula, ts: 3000, value: 39.25, flags: 0 });
      conn.send({ type: "alert", alert: "alr_1", formula: msg.formula, ts: 3000, value: 39.25, threshold: 40, direction: "below" });
    }
  };

  it("subscribes with the key header, collects only its formula, then unsubscribes", async () => {
    const rt = await client(() => undefined, relay);
    const w = await rt.watch("fml_1", 1);
    const conn = fake!.wsConns[0];
    expect(conn.headers["x-api-key"]).toBe(KEY);
    expect(conn.url).toBe("/v1/stream");
    expect(w.interval).toBe(1);
    expect(w.horizonSeconds).toBe(60);
    expect(w.warmUntil).toBe(5000);
    expect(w.values).toEqual([
      { ts: 1000, value: 41.5, flags: 1, why: ["WARMING"] },
      { ts: 2000, value: null, flags: 80 },
      { ts: 3000, value: 39.25 },
    ]);
    expect(w.alerts).toHaveLength(1);
    // give the unsubscribe frame a moment to land
    await new Promise((r) => setTimeout(r, 50));
    expect(conn.received).toEqual([
      { op: "subscribe", id: "w1", formula: "fml_1" },
      { op: "unsubscribe", id: "w2", formula: "fml_1" },
    ]);
  });

  it("a closing message ends the watch early with its reason", async () => {
    const rt = await client(
      () => undefined,
      (conn, msg) => {
        if (msg?.op === "subscribe") {
          conn.send({ type: "subscribed", id: msg.id, formula: msg.formula, interval: 1, horizonSeconds: 0, warmUntil: 0 });
          conn.send({ type: "value", formula: msg.formula, ts: 1000, value: 1, flags: 0 });
          conn.send({ type: "closing", reason: "quota", retryAfterMs: 3000 });
        }
      },
    );
    const started = Date.now();
    const w = await rt.watch("fml_1", 30);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(w.closing).toEqual({ reason: "quota", retryAfterMs: 3000 });
    expect(w.values).toHaveLength(1);
  });

  it("a subscribe error rejects with the code and a plain explanation", async () => {
    const rt = await client(
      () => undefined,
      (conn, msg) => {
        if (msg?.op === "subscribe") conn.send({ type: "error", id: msg.id, code: "live_limit", message: "at limit" });
      },
    );
    const err = (await rt.watch("fml_1", 5).catch((e) => e)) as RealtimeApiError;
    expect(err.code).toBe("live_limit");
    expect(err.message).toContain("maximum number of live formulas");
  });

  it("formula_invalid (saved under the old 300 s limit) rejects with the checker's located error", async () => {
    const error = {
      code: "window_out_of_range",
      message: "windows run from 1s to 60s (1m); this one is 300s",
      at: { offset: 24, line: 1, column: 25, length: 4 },
      source: "buyVol(binance:BTCUSDT, 300s)",
      pointer: "                        ^^^^",
      suggestions: ["60s"],
      expected: null,
      docs: "https://blackforge.so/docs/formulas#window_out_of_range",
    };
    const rt = await client(
      () => undefined,
      (conn, msg) => {
        if (msg?.op === "subscribe")
          conn.send({
            type: "error",
            id: msg.id,
            code: "formula_invalid",
            formula: "fml_1",
            message: "Formula fml_1 no longer passes the formula check: windows run from 1s to 60s (1m); this one is 300s. Create it again within the current limits.",
            error,
          });
      },
    );
    const err = (await rt.watch("fml_1", 5).catch((e) => e)) as RealtimeApiError;
    expect(err.code).toBe("formula_invalid");
    expect(err.formulaError).toEqual(error);
    expect(err.message).toContain("no longer passes the formula check");
    expect(err.message).toContain("Suggestions: 60s");
  });

  it("a refused upgrade rejects with a message that points at the key and plan", async () => {
    const rt = await client(() => undefined, undefined, { rejectWs: 401 });
    const err = (await rt.watch("fml_1", 5).catch((e) => e)) as Error;
    expect(err.message).toMatch(/refused or dropped|closed before/);
  });

  it("no global WebSocket: a clear Node version message, nothing else breaks", async () => {
    const rt = new RealtimeClient({ apiKey: KEY, realtimeUrl: "http://127.0.0.1:1", WebSocket: undefined });
    // Force the missing-constructor path regardless of the running Node.
    (rt as unknown as { wsCtor: undefined }).wsCtor = undefined;
    await expect(rt.watch("fml_1", 1)).rejects.toThrow(/Node 22/);
  });
});

describe("pure helpers", () => {
  it("summarizeWatch: first/last/min/max ignore nulls; flags counted from why or the mask", () => {
    const s = summarizeWatch([
      { ts: 1, value: 5, flags: 1, why: ["WARMING"] },
      { ts: 2, value: null, flags: 80 },
      { ts: 3, value: -2 },
      { ts: 4, value: 9 },
    ]);
    expect(s.samples).toBe(4);
    expect(s.nonNull).toBe(3);
    expect(s.first).toEqual({ ts: 1, value: 5 });
    expect(s.last).toEqual({ ts: 4, value: 9 });
    expect(s.min).toEqual({ ts: 3, value: -2 });
    expect(s.max).toEqual({ ts: 4, value: 9 });
    expect(s.flagsSeen).toEqual({ WARMING: 1, SOURCE_STALE: 1, NO_MID: 1 });
    expect(Object.keys(s.flagNotes).sort()).toEqual(["NO_MID", "SOURCE_STALE", "WARMING"]);
  });

  it("summarizeWatch on an empty stream", () => {
    expect(summarizeWatch([])).toMatchObject({ samples: 0, nonNull: 0, first: null, last: null, min: null, max: null });
  });

  it("decodeValueFlags follows the contract bit table", () => {
    expect(decodeValueFlags(0)).toEqual([]);
    expect(decodeValueFlags(80)).toEqual(["SOURCE_STALE", "NO_MID"]);
    expect(decodeValueFlags(1 | 512)).toEqual(["WARMING", "LATE_PRINTS"]);
  });

  it("toRealtimeError keeps a Nest-style message and prefixes an unknown code", () => {
    expect(toRealtimeError(400, "Bad Request", { message: ["name too long"] }, "formula").message).toBe("name too long");
    expect(toRealtimeError(409, "Conflict", { error: { code: "stored_limit", message: "20 saved" } }, "formula").message).toBe(
      "stored_limit: 20 saved",
    );
    expect(toRealtimeError(500, "Internal Server Error", undefined, "snapshot").message).toBe("Internal Server Error");
  });
});
