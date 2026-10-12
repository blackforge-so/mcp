// MCP tools for live formulas, notifications and live order book reads.
// Registered from index.ts; kept here so index.ts stays the /v1 history tools.
//
// Copy rules for every string below (they are shown to users by MCP hosts):
// no em dashes, and a notification is "your formula crossed the value you
// set", never anything that reads as advice.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RealtimeClient, summarizeWatch } from "./realtime.js";
import { BlackForgeApiError } from "./types.js";

const FORMULA_LANGUAGE =
  "A formula is an arithmetic expression over live order book and trade data, evaluated server-side every " +
  "interval (default 1 s). Pairs are written venue:SYMBOL exactly as blackforge_symbols spells them " +
  "(binance:BTCUSDT, okx:BTC-USDT, coinbase:BTC-USD), and one formula may combine pairs on different venues. " +
  "Durations are 1s to 300s, or 1m to 5m. " +
  "Book state, read now: bid ask bidQty askQty mid spread spreadBps bidLevels askLevels quoteUsd last lastAge, each (pair). " +
  "Book walk: bidDepth askDepth imbalance (pair, bps) with bps an integer 1 to 200 written as a number; " +
  "buyCost sellCost (pair, usd) with usd 100 to 1000000, result in bps. " +
  "Trades over a window: buyVol sellVol vol buyUsd sellUsd volUsd buyCount sellCount tradeCount netFlow buyShare " +
  "vwap high low open close maxBuy maxSell (pair, duration); buyUsdAbove sellUsdAbove buyCountAbove sellCountAbove " +
  "(pair, duration, usd) with usd one of 100, 1000, 10000, 100000. " +
  "Book changes over a window: bidAdded askAdded bidRemoved askRemoved bidAddedNear askAddedNear bidRemovedNear " +
  "askRemovedNear bookChanges (pair, duration). " +
  "Scalar: abs sign sqrt ln log10 exp pow min max clamp round floor ceil if coalesce. " +
  "Windows over any expression: avgOver minOver maxOver stdOver change pctChange (expr, duration). " +
  "Operators + - * / ^, comparisons, and, or, not. A missing input gives null, never a made-up number. " +
  "The sum of windows on any path (the horizon) is at most 300 s. " +
  "Examples: mid(binance:BTCUSDT) - mid(okx:BTC-USDT); imbalance(binance:ETHUSDT, 50); " +
  "buyVol(binance:SOLUSDT, 60s) / max(sellVol(binance:SOLUSDT, 60s), 1); avgOver(spreadBps(kraken:XBTUSD), 2m).";

const ULTRA_NOTE = "Live formulas and notifications are part of the Ultra plan.";
const SNAPSHOT_NOTE = "Live order book reads need the Max or Ultra plan and are charged against the monthly row quota.";

/** Run a call, return pretty JSON, translate errors into tool errors (same text shape as index.ts). */
async function run(fn: () => Promise<unknown>) {
  try {
    const payload = await fn();
    return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
  } catch (err) {
    const text =
      err instanceof BlackForgeApiError
        ? err.status > 0
          ? `BlackForge API error (HTTP ${err.status}): ${err.message}`
          : `BlackForge error: ${err.message}`
        : `BlackForge MCP error: ${(err as Error).message}`;
    return { isError: true, content: [{ type: "text" as const, text }] };
  }
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const DELETE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } as const;

const interval = z
  .number()
  .int()
  .min(1)
  .max(60)
  .optional()
  .describe("Seconds between evaluations, 1 to 60. Default 1.");

export function registerRealtimeTools(server: McpServer, rt: RealtimeClient = new RealtimeClient()): void {
  // ── blackforge_formula_validate ──
  server.registerTool(
    "blackforge_formula_validate",
    {
      title: "Check a live formula",
      description:
        "Check a live formula without saving it. Free and unmetered, so iterate on it freely. On success returns " +
        "{ ok: true, normalised, pairs, primitives, horizonSeconds, cost: { rowsPerEvaluation, rowsPer30Days } }. " +
        "On a refusal returns { ok: false, error } where error carries a stable code, a message, the location " +
        "(at, pointer under the source) and suggestions such as the correct pair spelling: apply them and check " +
        "again. " +
        FORMULA_LANGUAGE +
        " " +
        ULTRA_NOTE,
      inputSchema: {
        expr: z.string().describe("The formula source, e.g. mid(binance:BTCUSDT) - mid(okx:BTC-USDT)."),
        interval,
      },
      annotations: { title: "Check a live formula", ...READ },
    },
    ({ expr, interval }) => run(() => rt.validate(expr, interval)),
  );

  // ── blackforge_formula_create ──
  server.registerTool(
    "blackforge_formula_create",
    {
      title: "Save a live formula",
      description:
        "Save a live formula to the account so it can be streamed (blackforge_formula_watch) and carry " +
        "notifications (blackforge_alert_create). Returns { formula: { id, name, expr, interval, pairs, " +
        "horizonSeconds, ... } }. A refused formula comes back as an error with the same located, coded detail " +
        "blackforge_formula_validate gives; validate first. Saving is free; a formula is charged one row per " +
        "referenced pair per evaluation only while it is streamed or watched by a notification. " +
        ULTRA_NOTE,
      inputSchema: {
        name: z.string().min(1).max(80).describe("A short name, 1 to 80 characters."),
        expr: z.string().describe("The formula source (see blackforge_formula_validate for the language)."),
        interval,
        ephemeral: z
          .boolean()
          .optional()
          .describe("true stores it for one hour only, outside the saved-formula count. Default false."),
      },
      annotations: { title: "Save a live formula", ...WRITE },
    },
    ({ name, expr, interval, ephemeral }) => run(() => rt.createFormula({ name, expr, interval, ephemeral })),
  );

  // ── blackforge_formula_list ──
  server.registerTool(
    "blackforge_formula_list",
    {
      title: "List live formulas",
      description:
        "List the account's saved live formulas, with the plan's limits and current usage " +
        "({ formulas, limits, usage: { live, stored, connections } }). " +
        ULTRA_NOTE,
      inputSchema: {},
      annotations: { title: "List live formulas", ...READ },
    },
    () => run(() => rt.listFormulas()),
  );

  // ── blackforge_formula_delete ──
  server.registerTool(
    "blackforge_formula_delete",
    {
      title: "Delete a live formula",
      description:
        "Delete a saved live formula. Its notifications are deleted with it and listed in deletedAlerts. " +
        "Cannot be undone.",
      inputSchema: { formulaId: z.string().describe("The formula id, fml_...") },
      annotations: { title: "Delete a live formula", ...DELETE },
    },
    ({ formulaId }) => run(() => rt.deleteFormula(formulaId)),
  );

  // ── blackforge_formula_watch ──
  server.registerTool(
    "blackforge_formula_watch",
    {
      title: "Watch a live formula",
      description:
        "Stream a live formula for a few seconds and return what arrived: first, last, min, max, the number of " +
        "samples, which value flags appeared (with a plain note for each), and the full series of { ts, value, " +
        "flags? } with ts in epoch milliseconds. Pass formulaId for a saved formula, or expr to watch a formula " +
        "once (it is saved as a one-hour formula first). seconds is 1 to 60, default 20. A value flagged WARMING " +
        "is computed over less than its full window, because the formula is younger than its horizon; it settles " +
        "by warmUntil. null means there was no number (for example no print in a trade window), never zero. " +
        "Charged one row per referenced pair per evaluation. " +
        ULTRA_NOTE,
      inputSchema: {
        formulaId: z.string().optional().describe("A saved formula id, fml_... Pass this or expr."),
        expr: z.string().optional().describe("A formula source to watch once. Pass this or formulaId."),
        interval: interval.describe("Only with expr: seconds between evaluations, 1 to 60. Default 1."),
        seconds: z.number().int().min(1).max(60).optional().describe("How long to collect, 1 to 60 s. Default 20."),
      },
      annotations: { title: "Watch a live formula", ...READ, idempotentHint: false },
    },
    ({ formulaId, expr, interval, seconds }) =>
      run(async () => {
        if (Boolean(formulaId) === Boolean(expr)) {
          throw new BlackForgeApiError(0, "Pass exactly one of formulaId or expr.");
        }
        const secs = seconds ?? 20;
        let id = formulaId as string;
        let created: Record<string, unknown> | undefined;
        if (expr) {
          const r = await rt.createFormula({
            name: `watch: ${expr}`.slice(0, 80),
            expr,
            interval,
            ephemeral: true,
          });
          created = r.formula;
          id = String(r.formula?.id ?? "");
          if (!id) throw new BlackForgeApiError(0, "The API saved the formula but returned no id.");
        } else {
          // Preflight on the API: a missing formula or a plan refusal comes back
          // as a clear HTTP error here, where a refused WebSocket upgrade carries
          // no status at all.
          await rt.getFormula(id);
        }
        const w = await rt.watch(id, secs);
        const summary = summarizeWatch(w.values);
        return {
          formula: id,
          ...(created ? { createdEphemeral: { id, expr: created.expr ?? expr, expiresIn: "1 hour" } } : {}),
          interval: w.interval,
          horizonSeconds: w.horizonSeconds,
          warmUntil: w.warmUntil,
          seconds: secs,
          ...summary,
          series: w.values,
          ...(w.alerts.length ? { notifications: w.alerts } : {}),
          ...(w.closing ? { closing: w.closing } : {}),
          ...(w.usage ? { usage: w.usage } : {}),
        };
      }),
  );

  // ── blackforge_alert_create ──
  server.registerTool(
    "blackforge_alert_create",
    {
      title: "Notify when a formula crosses a value",
      description:
        "Get notified when a saved live formula crosses a value you set. It is evaluated server-side every " +
        "interval, whether or not anything is connected. direction: above (goes from at or below the threshold to " +
        "above it), below (the reverse), or cross (either). After it fires it waits until the value is back on " +
        "the other side by at least hysteresis and cooldownSeconds (60 to 86400, default 900) have passed. If the " +
        "condition is already true when created, it starts disarmed and arms once the value is back across. It " +
        "never fires on null or on a WARMING or stale value. Email goes to the account's verified address " +
        "(default on); webhookUrl (https) optionally receives a signed POST. The response carries webhookSecret " +
        "ONCE: store it to verify the x-blackforge-signature header (t=<unix>,v1=<hex HMAC-SHA256 of t.body>). " +
        ULTRA_NOTE,
      inputSchema: {
        formulaId: z.string().describe("The saved formula id, fml_..."),
        direction: z.enum(["above", "below", "cross"]).describe("above, below or cross."),
        threshold: z.number().describe("The value your formula must cross."),
        hysteresis: z.number().min(0).optional().describe("How far back across it must go to re-arm. Default 0."),
        cooldownSeconds: z.number().int().min(60).max(86400).optional().describe("Minimum seconds between notifications. Default 900."),
        email: z.boolean().optional().describe("Email the account's verified address. Default true."),
        webhookUrl: z.string().url().optional().describe("Optional https URL that receives a signed JSON POST."),
      },
      annotations: { title: "Notify when a formula crosses a value", ...WRITE },
    },
    (args) =>
      run(async () => {
        const data = await rt.createAlert(args);
        return typeof data.webhookSecret === "string"
          ? {
              ...data,
              webhookSecretNote:
                "Shown once and not stored by BlackForge. Save it now; it verifies the x-blackforge-signature header on every webhook.",
            }
          : data;
      }),
  );

  // ── blackforge_alert_list ──
  server.registerTool(
    "blackforge_alert_list",
    {
      title: "List formula notifications",
      description:
        "List the account's formula notifications ({ alerts, limits }). Each carries its formula, direction, " +
        "threshold, status (active, paused, quota, plan), whether it is armed, and when it last fired. " +
        ULTRA_NOTE,
      inputSchema: {},
      annotations: { title: "List formula notifications", ...READ },
    },
    () => run(() => rt.listAlerts()),
  );

  // ── blackforge_alert_delete ──
  server.registerTool(
    "blackforge_alert_delete",
    {
      title: "Delete a formula notification",
      description: "Delete a formula notification. The formula itself is kept. Cannot be undone.",
      inputSchema: { alertId: z.string().describe("The notification id, alr_...") },
      annotations: { title: "Delete a formula notification", ...DELETE },
    },
    ({ alertId }) => run(() => rt.deleteAlert(alertId)),
  );

  // ── blackforge_book ──
  server.registerTool(
    "blackforge_book",
    {
      title: "Live order book",
      description:
        "Read the live order book for one pair right now: the top levels on both sides as [price, quantity] " +
        "pairs, when it was read (observedAtMs), whether the book is synced or crossed, and level counts. " +
        "levels is 1 to 200, default 20. Charged 2 rows per level returned. " +
        SNAPSHOT_NOTE,
      inputSchema: {
        exchange: z.string().describe("Venue from blackforge_catalog, e.g. binance."),
        symbol: z.string().describe("Pair as blackforge_symbols spells it, e.g. BTCUSDT or BTC-USDT."),
        levels: z.number().int().min(1).max(200).optional().describe("Levels per side, 1 to 200. Default 20."),
      },
      annotations: { title: "Live order book", ...READ, idempotentHint: false },
    },
    ({ exchange, symbol, levels }) => run(() => rt.book(exchange, symbol, levels)),
  );

  // ── blackforge_fill ──
  server.registerTool(
    "blackforge_fill",
    {
      title: "Simulate a market order",
      description:
        "Walk the live order book to price a market order of a given size right now, without placing anything. " +
        "Give usd (notional in USD) or size (base quantity). Returns { complete, bps, partialBps, levelsWalked, " +
        "vwap, depthLimited, bookExhausted }: bps is the cost against the mid in basis points and is null unless " +
        "the visible book could fill the whole order (then see partialBps, and do not quote it as the cost). " +
        "Charged one row per level walked. " +
        SNAPSHOT_NOTE,
      inputSchema: {
        exchange: z.string().describe("Venue, e.g. binance."),
        symbol: z.string().describe("Pair as blackforge_symbols spells it."),
        side: z.enum(["buy", "sell"]).describe("buy walks the asks, sell walks the bids."),
        usd: z.number().positive().optional().describe("Order notional in USD. Pass this or size."),
        size: z.number().positive().optional().describe("Order size in the base asset. Pass this or usd."),
      },
      annotations: { title: "Simulate a market order", ...READ, idempotentHint: false },
    },
    ({ exchange, symbol, side, usd, size }) =>
      run(async () => {
        if ((usd === undefined) === (size === undefined)) {
          throw new BlackForgeApiError(0, "Pass exactly one of usd or size.");
        }
        return rt.fill({ exchange, symbol, side, usd, size });
      }),
  );

  // ── blackforge_spread_map ──
  server.registerTool(
    "blackforge_spread_map",
    {
      title: "Live spread across venues",
      description:
        "Best bid and best ask for one base/quote pair on every venue that lists it, all read within the same " +
        "moment, so a difference between venues is a real difference rather than a timing artefact. " +
        "Charged 2 rows per venue. " +
        SNAPSHOT_NOTE,
      inputSchema: {
        base: z.string().describe("Base asset, e.g. BTC."),
        quote: z.string().describe("Quote asset, e.g. USDT."),
      },
      annotations: { title: "Live spread across venues", ...READ, idempotentHint: false },
    },
    ({ base, quote }) => run(() => rt.spreadMap(base, quote)),
  );
}
