// Live formulas, notifications and live order book reads.
//
// Two hosts, one key:
//   - the API (`BLACKFORGE_BASE_URL`, default https://api.blackforge.so) stores
//     formulas and notifications: /v1/formulas*, /v1/alerts*;
//   - the realtime relay (`BLACKFORGE_REALTIME_URL`, default
//     https://realtime.blackforge.so) streams formula values over WebSocket
//     (/v1/stream) and answers the live snapshot reads (/v1/book, /v1/fill,
//     /v1/spread-map).
// Both take the key in `x-api-key`. The key is NEVER put in a URL: the relay
// refuses `?key=` on purpose, because keys in URLs end up in logs.
//
// The WebSocket is Node's built-in one (undici, global since Node 22), which
// accepts a non-standard `headers` init. That keeps the runtime dependency
// count at two. On a Node without a global WebSocket only the watch tool
// fails, with a message saying so; everything else here is plain fetch.
//
// Shapes are the realtime-formulas contract (§6.1, §6.3); this file re-shapes
// nothing it does not have to, so a new field the server adds reaches the
// model untouched.

import { BlackForgeApiError } from "./types.js";

const DEFAULT_BASE_URL = "https://api.blackforge.so";
const DEFAULT_REALTIME_URL = "https://realtime.blackforge.so";
const PRICING_URL = "https://blackforge.so/pricing";

/** What a call was for, so a plan refusal can name the plan that unlocks it. */
export type RealtimeContext = "formula" | "snapshot";

/** The located, coded formula error of contract §3.8, passed through verbatim. */
export interface FormulaError {
  code: string;
  message: string;
  at?: { offset: number; line: number; column: number; length: number } | null;
  source?: string;
  pointer?: string | null;
  suggestions?: string[];
  expected?: string[] | null;
  docs?: string;
  [k: string]: unknown;
}

/** An API or relay refusal. `code` is the server's machine code when it sent one. */
export class RealtimeApiError extends BlackForgeApiError {
  code: string | undefined;
  body: unknown;
  formulaError: FormulaError | undefined;
  constructor(status: number, message: string, opts?: { code?: string; body?: unknown; formulaError?: FormulaError }) {
    super(status, message);
    this.name = "RealtimeApiError";
    this.code = opts?.code;
    this.body = opts?.body;
    this.formulaError = opts?.formulaError;
  }
}

function isFormulaError(e: unknown): e is FormulaError {
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as FormulaError).code === "string" &&
    typeof (e as FormulaError).message === "string" &&
    ("pointer" in e || "at" in e || "source" in e)
  );
}

/** Human text for a formula refusal: the server's words first, then the raw object. */
export function formatFormulaError(e: FormulaError): string {
  const lines = [`The formula was refused (${e.code}): ${e.message}`];
  if (e.source) lines.push(`  ${e.source}`);
  if (e.pointer) lines.push(`  ${e.pointer}`);
  if (e.suggestions && e.suggestions.length) lines.push(`Suggestions: ${e.suggestions.join(", ")}`);
  if (e.expected && e.expected.length) lines.push(`Expected one of: ${e.expected.join(", ")}`);
  if (e.docs) lines.push(`Docs: ${e.docs}`);
  lines.push("Fix the formula and check it again with blackforge_formula_validate.");
  lines.push(JSON.stringify({ error: e }, null, 2));
  return lines.join("\n");
}

function planMessage(ctx: RealtimeContext, upgrade: string | undefined): string {
  const url = upgrade || PRICING_URL;
  return ctx === "formula"
    ? `Live formulas and notifications are part of the Ultra plan, and this key's plan does not include them. Upgrade at ${url}. The 5-minute history (blackforge_latest, blackforge_series) stays available on the current plan.`
    : `Live order book reads (book, fill, spread map) need the Max or Ultra plan, and this key's plan does not include them. Upgrade at ${url}.`;
}

/** Turn any non-2xx body (API `{error:{code}}`, relay `{error:"code"}`, Nest `{message}`) into one error. */
export function toRealtimeError(
  status: number,
  statusText: string,
  body: unknown,
  ctx: RealtimeContext,
  what?: { exchange?: string; symbol?: string },
): RealtimeApiError {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const rawErr = b.error;
  const errObj = (typeof rawErr === "object" && rawErr !== null ? rawErr : {}) as Record<string, unknown>;
  const code =
    typeof rawErr === "string" ? rawErr : typeof errObj.code === "string" ? (errObj.code as string) : undefined;
  const serverMessage =
    typeof errObj.message === "string"
      ? (errObj.message as string)
      : Array.isArray(b.message)
        ? (b.message as string[]).join("; ")
        : typeof b.message === "string"
          ? (b.message as string)
          : undefined;
  const retryAfterMs =
    typeof b.retryAfterMs === "number"
      ? b.retryAfterMs
      : typeof errObj.retryAfterMs === "number"
        ? (errObj.retryAfterMs as number)
        : undefined;

  if (status === 400 && isFormulaError(errObj)) {
    return new RealtimeApiError(status, formatFormulaError(errObj), { code, body, formulaError: errObj });
  }

  let message: string;
  switch (code) {
    case "plan_required":
      message = planMessage(ctx, typeof errObj.upgrade === "string" ? (errObj.upgrade as string) : undefined);
      break;
    case "realtime_disabled":
      message = "Live formulas are switched off on this server right now. Try again later.";
      break;
    case "invalid_credentials":
      message = "The API key was refused. Check BLACKFORGE_API_KEY (mint one at app.blackforge.so/api).";
      break;
    case "unknown-symbol":
    case "unknown_symbol":
      message = `${what?.exchange ?? "That venue"} has no live pair ${what?.symbol ?? ""}. List the exact spelling with blackforge_symbols.`.replace(
        /\s+\./,
        ".",
      );
      break;
    case "wrong-exchange":
    case "unknown_exchange":
      message = `Unknown venue ${what?.exchange ?? ""}. Valid venues are listed by blackforge_catalog.`.replace(/\s+\./, ".");
      break;
    case "not-owned":
    case "busy":
      message = "The live book for that pair is briefly unavailable (it is moving between collectors). Retry in a few seconds.";
      break;
    case "budget":
    case "rate_limited":
      message = `The live read budget is used up for the moment. Retry in ${Math.ceil((retryAfterMs ?? 1000) / 1000)} s.`;
      break;
    case "quota_exhausted":
    case "quota":
      message = "This key's monthly row quota is used up. See blackforge_usage, or upgrade at " + PRICING_URL + ".";
      break;
    default:
      message = serverMessage ?? (code ? code : statusText || `HTTP ${status}`);
      if (serverMessage && code && !serverMessage.includes(code)) message = `${code}: ${serverMessage}`;
  }
  return new RealtimeApiError(status, message, { code, body });
}

// ── value flags (contract §5) ────────────────────────────────────────────────
// The live value flags are a fixed table of the realtime protocol (distinct
// from the 5-minute rows' quality bits, which this server always reads from
// the catalog). The relay sends the names in `why`; this table is only the
// fallback decode and the plain-language note beside each name.

export const VALUE_FLAGS: ReadonlyArray<{ bit: number; name: string; note: string }> = [
  { bit: 1, name: "WARMING", note: "a windowed term does not yet cover its whole window (the formula is younger than its horizon); values settle after warmUntil" },
  { bit: 2, name: "BOOK_NOT_SYNCED", note: "a referenced order book was resyncing or seeding when read; the value is labelled, not dropped" },
  { bit: 4, name: "DEPTH_FLOOR", note: "a depth band reaches past the deepest fresh level held, so that depth figure is a floor" },
  { bit: 8, name: "FILL_DEPTH_LIMITED", note: "a fill walk reached the level cap, so that cost term is null" },
  { bit: 16, name: "SOURCE_STALE", note: "a referenced venue's newest data was over 3 s old (after 10 s its terms are null)" },
  { bit: 32, name: "NO_TRADES", note: "a trade term had no print in its window" },
  { bit: 64, name: "NO_MID", note: "a referenced book was empty, one-sided or crossed" },
  { bit: 128, name: "RATE_MISSING", note: "a USD term had no quote-to-USD rate" },
  { bit: 256, name: "PAIR_UNAVAILABLE", note: "a referenced pair has left the venue" },
  { bit: 512, name: "LATE_PRINTS", note: "some prints arrived late, so attribution shifted by up to 2 s" },
];

export function decodeValueFlags(mask: number): string[] {
  return VALUE_FLAGS.filter((f) => (mask & f.bit) !== 0).map((f) => f.name);
}

export interface StreamValue {
  ts: number;
  value: number | null;
  flags?: number;
  why?: string[];
}

export interface WatchSummary {
  samples: number;
  nonNull: number;
  first: { ts: number; value: number | null } | null;
  last: { ts: number; value: number | null } | null;
  min: { ts: number; value: number } | null;
  max: { ts: number; value: number } | null;
  flagsSeen: Record<string, number>;
  flagNotes: Record<string, string>;
}

/** Pure summary of a collected stream: first/last/min/max and how often each flag appeared. */
export function summarizeWatch(values: StreamValue[]): WatchSummary {
  const flagsSeen: Record<string, number> = {};
  let min: WatchSummary["min"] = null;
  let max: WatchSummary["max"] = null;
  let nonNull = 0;
  for (const v of values) {
    const names = v.why && v.why.length ? v.why : decodeValueFlags(v.flags ?? 0);
    for (const n of names) flagsSeen[n] = (flagsSeen[n] ?? 0) + 1;
    if (typeof v.value === "number" && Number.isFinite(v.value)) {
      nonNull++;
      if (!min || v.value < min.value) min = { ts: v.ts, value: v.value };
      if (!max || v.value > max.value) max = { ts: v.ts, value: v.value };
    }
  }
  const flagNotes: Record<string, string> = {};
  for (const n of Object.keys(flagsSeen)) {
    const f = VALUE_FLAGS.find((x) => x.name === n);
    if (f) flagNotes[n] = f.note;
  }
  const at = (v: StreamValue | undefined) => (v ? { ts: v.ts, value: v.value } : null);
  return {
    samples: values.length,
    nonNull,
    first: at(values[0]),
    last: at(values[values.length - 1]),
    min,
    max,
    flagsSeen,
    flagNotes,
  };
}

// ── the client ───────────────────────────────────────────────────────────────

export interface WatchResult {
  formula: string;
  interval?: number;
  horizonSeconds?: number;
  warmUntil?: number;
  seconds: number;
  values: StreamValue[];
  alerts: unknown[];
  closing?: { reason: string; retryAfterMs?: number };
  usage?: unknown;
}

/** Minimal shape of the WHATWG WebSocket Node ships, plus undici's `headers` init. */
interface WsLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, fn: (ev: any) => void): void;
}
type WsCtor = new (url: string, init?: { headers?: Record<string, string>; protocols?: string[] }) => WsLike;

export class RealtimeClient {
  readonly baseUrl: string;
  readonly realtimeUrl: string;
  private apiKey: string | undefined;
  private wsCtor: WsCtor | undefined;

  constructor(opts?: { baseUrl?: string; realtimeUrl?: string; apiKey?: string; WebSocket?: WsCtor }) {
    this.baseUrl = (opts?.baseUrl ?? process.env.BLACKFORGE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.realtimeUrl = (opts?.realtimeUrl ?? process.env.BLACKFORGE_REALTIME_URL ?? DEFAULT_REALTIME_URL).replace(
      /\/+$/,
      "",
    );
    this.apiKey = opts?.apiKey ?? process.env.BLACKFORGE_API_KEY;
    this.wsCtor = opts?.WebSocket ?? ((globalThis as { WebSocket?: unknown }).WebSocket as WsCtor | undefined);
  }

  private requireKey(): string {
    if (!this.apiKey) {
      throw new BlackForgeApiError(
        0,
        "BLACKFORGE_API_KEY is not set. Get a key at app.blackforge.so/api, then set it in the server env.",
      );
    }
    return this.apiKey;
  }

  private async call<T>(
    host: "api" | "relay",
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    ctx: RealtimeContext,
    opts?: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
      what?: { exchange?: string; symbol?: string };
    },
  ): Promise<{ status: number; data: T | undefined; headers: Headers }> {
    const key = this.requireKey();
    const base = host === "api" ? this.baseUrl : this.realtimeUrl;
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(opts?.query ?? {})) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { accept: "application/json", "x-api-key": key };
    if (opts?.body !== undefined) headers["content-type"] = "application/json";

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
    } catch (err) {
      const where = host === "api" ? `the BlackForge API at ${this.baseUrl}` : `the BlackForge realtime host at ${this.realtimeUrl}`;
      throw new BlackForgeApiError(0, `Could not reach ${where}: ${(err as Error).message}`);
    }

    const text = res.status === 204 ? "" : await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }
    if (!res.ok) throw toRealtimeError(res.status, res.statusText, parsed, ctx, opts?.what);
    return { status: res.status, data: parsed as T | undefined, headers: res.headers };
  }

  // ── formulas (API) ──

  /** Free and unmetered. A refusal comes back as `{ ok: false, error }`, never thrown. */
  async validate(expr: string, interval?: number): Promise<Record<string, unknown>> {
    try {
      const { data } = await this.call<Record<string, unknown>>("api", "POST", "/v1/formulas/validate", "formula", {
        body: { expr, ...(interval !== undefined ? { interval } : {}) },
      });
      return { ok: true, ...(data ?? {}) };
    } catch (err) {
      if (err instanceof RealtimeApiError && err.formulaError) return { ok: false, error: err.formulaError };
      throw err;
    }
  }

  async createFormula(args: { name: string; expr: string; interval?: number; ephemeral?: boolean }) {
    const { data } = await this.call<{ formula: Record<string, unknown> }>("api", "POST", "/v1/formulas", "formula", {
      body: args,
    });
    return data ?? { formula: {} };
  }

  async listFormulas() {
    const { data } = await this.call<Record<string, unknown>>("api", "GET", "/v1/formulas", "formula");
    return data ?? {};
  }

  async getFormula(id: string) {
    const { data } = await this.call<Record<string, unknown>>("api", "GET", `/v1/formulas/${encodeURIComponent(id)}`, "formula");
    return data ?? {};
  }

  async deleteFormula(id: string): Promise<{ deleted: string; deletedAlerts: string[] }> {
    const { headers } = await this.call("api", "DELETE", `/v1/formulas/${encodeURIComponent(id)}`, "formula");
    const raw = headers.get("x-blackforge-deleted-alerts");
    const deletedAlerts = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
    return { deleted: id, deletedAlerts };
  }

  // ── notifications (API) ──

  async createAlert(args: {
    formulaId: string;
    direction: "above" | "below" | "cross";
    threshold: number;
    hysteresis?: number;
    cooldownSeconds?: number;
    email?: boolean;
    webhookUrl?: string;
  }) {
    const body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) if (v !== undefined) body[k] = v;
    const { data } = await this.call<Record<string, unknown>>("api", "POST", "/v1/alerts", "formula", { body });
    return data ?? {};
  }

  async listAlerts() {
    const { data } = await this.call<Record<string, unknown>>("api", "GET", "/v1/alerts", "formula");
    return data ?? {};
  }

  async deleteAlert(id: string): Promise<{ deleted: string }> {
    await this.call("api", "DELETE", `/v1/alerts/${encodeURIComponent(id)}`, "formula");
    return { deleted: id };
  }

  // ── live snapshot reads (relay) ──

  async book(exchange: string, symbol: string, levels?: number) {
    const { data } = await this.call<Record<string, unknown>>(
      "relay",
      "GET",
      `/v1/book/${encodeURIComponent(exchange)}/${encodeURIComponent(symbol)}`,
      "snapshot",
      { query: { levels }, what: { exchange, symbol } },
    );
    return data ?? {};
  }

  async fill(args: { exchange: string; symbol: string; side: "buy" | "sell"; usd?: number; size?: number }) {
    const { exchange, symbol, side, usd, size } = args;
    const { data } = await this.call<Record<string, unknown>>(
      "relay",
      "GET",
      `/v1/fill/${encodeURIComponent(exchange)}/${encodeURIComponent(symbol)}`,
      "snapshot",
      { query: { side, usd, size }, what: { exchange, symbol } },
    );
    return data ?? {};
  }

  async spreadMap(base: string, quote: string) {
    const { data } = await this.call<Record<string, unknown>>("relay", "GET", "/v1/spread-map", "snapshot", {
      query: { base, quote },
    });
    return data ?? {};
  }

  // ── the stream (relay WebSocket) ──

  /**
   * Subscribe to one formula for `seconds` and collect what arrives. Resolves
   * early on a `closing` from the server; rejects on a subscribe `error` or a
   * connection that never opens.
   */
  watch(formulaId: string, seconds: number, opts?: { connectTimeoutMs?: number }): Promise<WatchResult> {
    const key = this.requireKey();
    const Ctor = this.wsCtor;
    if (!Ctor) {
      return Promise.reject(
        new BlackForgeApiError(
          0,
          `This Node (${process.version}) has no built-in WebSocket, which blackforge_formula_watch needs. Run the server on Node 22 or newer.`,
        ),
      );
    }
    const wsUrl = this.realtimeUrl.replace(/^http/i, "ws") + "/v1/stream";
    const connectTimeoutMs = opts?.connectTimeoutMs ?? 10_000;

    return new Promise<WatchResult>((resolve, reject) => {
      const result: WatchResult = { formula: formulaId, seconds, values: [], alerts: [] };
      let settled = false;
      let collectTimer: NodeJS.Timeout | undefined;
      let ws: WsLike;

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        if (collectTimer) clearTimeout(collectTimer);
        try {
          if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ op: "unsubscribe", id: "w2", formula: formulaId }));
          }
          ws?.close(1000, "done");
        } catch {
          // closing a socket that is already gone
        }
        if (err) reject(err);
        else resolve(result);
      };

      const connectTimer = setTimeout(
        () => finish(new BlackForgeApiError(0, `The realtime host at ${this.realtimeUrl} did not answer within ${connectTimeoutMs / 1000} s.`)),
        connectTimeoutMs,
      );

      try {
        ws = new Ctor(wsUrl, { headers: { "x-api-key": key } });
      } catch (err) {
        finish(new BlackForgeApiError(0, `Could not open the stream at ${wsUrl}: ${(err as Error).message}`));
        return;
      }

      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ op: "subscribe", id: "w1", formula: formulaId }));
      });

      ws.addEventListener("message", (ev: { data: unknown }) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        switch (msg.type) {
          case "subscribed":
            if (msg.formula !== undefined && msg.formula !== formulaId) return;
            clearTimeout(connectTimer);
            if (typeof msg.interval === "number") result.interval = msg.interval;
            if (typeof msg.horizonSeconds === "number") result.horizonSeconds = msg.horizonSeconds;
            if (typeof msg.warmUntil === "number") result.warmUntil = msg.warmUntil;
            collectTimer = setTimeout(() => finish(), seconds * 1000);
            break;
          case "value":
            if (msg.formula !== formulaId) return;
            result.values.push({
              ts: msg.ts as number,
              value: typeof msg.value === "number" ? msg.value : null,
              ...(typeof msg.flags === "number" && msg.flags !== 0 ? { flags: msg.flags } : {}),
              ...(Array.isArray(msg.why) && msg.why.length ? { why: msg.why as string[] } : {}),
            });
            break;
          case "alert":
            if (msg.formula === formulaId) {
              const { type: _t, ...rest } = msg;
              result.alerts.push(rest);
            }
            break;
          case "usage": {
            const { type: _t, ...rest } = msg;
            result.usage = rest;
            break;
          }
          case "error":
            if (msg.id === undefined || msg.id === "w1") {
              const code = typeof msg.code === "string" ? msg.code : "error";
              const known = streamErrorMessage(code);
              // formula_invalid: a saved formula that no longer passes the language's limits
              // (e.g. a window over 60 s); the relay sends the checker's located error.
              const formulaError = code === "formula_invalid" && isFormulaError(msg.error) ? msg.error : undefined;
              const text = known ?? (typeof msg.message === "string" ? msg.message : "subscribe refused");
              finish(
                new RealtimeApiError(0, formulaError ? `${code}: ${text}\n${formatFormulaError(formulaError)}` : `${code}: ${text}`, {
                  code,
                  body: msg,
                  formulaError,
                }),
              );
            }
            break;
          case "closing":
            result.closing = {
              reason: String(msg.reason ?? "unknown"),
              ...(typeof msg.retryAfterMs === "number" ? { retryAfterMs: msg.retryAfterMs } : {}),
            };
            finish();
            break;
          default:
            break; // hello, pong, and anything newer
        }
      });

      ws.addEventListener("error", (ev: { message?: string; error?: Error }) => {
        const detail = ev?.message ?? ev?.error?.message ?? "connection error";
        finish(
          new BlackForgeApiError(
            0,
            `The realtime stream at ${wsUrl} refused or dropped the connection (${detail}). Check that the key is valid and on the Ultra plan.`,
          ),
        );
      });

      ws.addEventListener("close", () => {
        // A close after `subscribed` ends the collection with what arrived.
        if (collectTimer) finish();
        else finish(new BlackForgeApiError(0, `The realtime stream at ${wsUrl} closed before the subscription was confirmed.`));
      });
    });
  }
}

function streamErrorMessage(code: string): string | undefined {
  switch (code) {
    case "formula_not_found":
      return "no formula with that id. List yours with blackforge_formula_list.";
    case "not_yours":
      return "that formula belongs to another account.";
    case "plan_required":
      return planMessage("formula", undefined);
    case "quota_exhausted":
      return "this key's monthly row quota is used up.";
    case "live_limit":
      return "the account is already running its maximum number of live formulas. Stop one (or delete an alert that keeps one running) and try again.";
    case "capacity":
      return "the realtime service is at capacity right now. Try again shortly.";
    case "subscription_limit":
      return "this connection holds its maximum number of subscriptions.";
    default:
      return undefined;
  }
}
