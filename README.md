# @blackforge-so/mcp

A [Model Context Protocol](https://modelcontextprotocol.io) stdio server that puts
BlackForge market-data in your agent's hands. **The whole crypto market, in real time** —
nine spot venues (binance, bitget, bybit, coinbase, gate, kraken, kucoin, mexc, okx) and
every column it measures, per pair per closed 5-minute window.

Every column is a **measurement with a definition** — order-book depth and shape, resting
liquidity lifetimes, trade-explained vs book-implied volume, spreads, market-wide context —
returned in-context so an agent can read the raw microstructure directly. It is a thin client
over the public BlackForge `/v1` API; it stores nothing and re-shapes nothing.

## Quickstart

Add the server to your MCP client and paste an API key. **Claude Desktop**
(`claude_desktop_config.json`) or **Claude Code** (`.mcp.json`):

```json
{
  "mcpServers": {
    "blackforge": {
      "command": "npx",
      "args": ["-y", "@blackforge-so/mcp"],
      "env": { "BLACKFORGE_API_KEY": "bf_live_your_key" }
    }
  }
}
```

No install step — `npx -y @blackforge-so/mcp` fetches and runs the server on demand.

### Where to get a key

Mint a key at **[app.blackforge.so → API](https://app.blackforge.so/api)**. The server never
creates keys; it reads `BLACKFORGE_API_KEY` from its environment. The `blackforge_catalog`
tool works **without a key**, so you can verify the install before pasting one.

## Tools

| Tool | Returns |
|------|---------|
| `blackforge_catalog` | Every venue and every column definition — 9 venues, and `metricCount` is the live column count. Keyless. **Call this first** to learn valid `exchange` and `metric` identifiers. |
| `blackforge_symbols` | The trading pairs a venue lists, e.g. `["BTCUSDT", …]`. |
| `blackforge_latest` | The latest completed 5-minute window for one `(exchange, symbol)` — a `values` object of column → number, with epoch-ms `ts`. Pass `columns` to narrow it. |
| `blackforge_series` | A time series for one column over a range: ascending `{ ts, value }` points at `5m`, `1h`, or `1d`. Capped at 50,000 points. |
| `blackforge_usage` | The key's recent request counts and remaining monthly row quota. |

Plan entitlements (which venues, columns, and intervals a key may read) are enforced by the
API. When a column is dropped because your plan does not include it, the tool result reports
it in `columnsOmitted` so the agent understands why a key is absent. Venue- or interval-level
restrictions come back as a clear tool error carrying the HTTP status and the server's message
(including the upgrade URL, verbatim).

## Live formulas and the live order book

Beyond the 5-minute history, the server reaches BlackForge's realtime host. Write your own
measure from order book and trade data across the major venues, stream it every second, and
get notified when it crosses a value you choose.

| Tool | Does | Plan |
|------|------|------|
| `blackforge_formula_validate` | Checks a formula without saving it. Free. A refusal comes back as data: a stable `code`, the location with a `pointer` under the source, and `suggestions` (e.g. the venue's real pair spelling), so an agent can fix it and check again. | Ultra |
| `blackforge_formula_create` | Saves a formula (`name`, `expr`, `interval` 1 to 60 s). | Ultra |
| `blackforge_formula_list` | Saved formulas, your limits and current usage. | Ultra |
| `blackforge_formula_delete` | Deletes a formula and the notifications on it. | Ultra |
| `blackforge_formula_watch` | Streams a saved formula (`formulaId`) or a one-off `expr` for up to 60 s (default 20) and returns first, last, min, max, the flags seen and the full series. | Ultra |
| `blackforge_alert_create` | Notifies you when a formula crosses a value you set (`above`, `below`, `cross`), by email and optionally a signed `webhookUrl`. The webhook secret is shown once. | Ultra |
| `blackforge_alert_list` / `blackforge_alert_delete` | List or delete notifications. | Ultra |
| `blackforge_book` | The live order book for one pair, up to 200 levels a side. | Max, Ultra |
| `blackforge_fill` | Prices a market order against the live book (`usd` or `size`); `bps` is null unless the visible book fills it all. | Max, Ultra |
| `blackforge_spread_map` | Best bid and ask for one base/quote on every venue that lists it, read in the same moment. | Max, Ultra |

A formula looks like `mid(binance:BTCUSDT) - mid(okx:BTC-USDT)` or
`buyVol(binance:SOLUSDT, 60s) / max(sellVol(binance:SOLUSDT, 60s), 1)`. Pairs are spelled
exactly as `blackforge_symbols` lists them. The full function list is in the
`blackforge_formula_validate` tool description. Streaming and notifications are charged one
row per referenced pair per evaluation; live book reads by levels returned or walked, against
the same monthly quota as everything else. Every streamed value carries `flags` (for example
`WARMING` while a windowed term has not filled its window yet) and `null` means there was no
number, never zero.

The stream uses Node's built-in WebSocket, so `blackforge_formula_watch` needs **Node 22 or
newer**; every other tool runs on Node 20. Your key travels in the `x-api-key` header, never
in a URL.

## Charts

`blackforge_series` also ships an interactive chart. A host that implements the
[MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) extension
(`io.modelcontextprotocol/ui`) renders the result as a line chart with flagged buckets drawn
in the same convention the BlackForge console uses; every other host sees exactly the JSON it
saw before.

Nothing about the tool contract changes. The chart payload travels in the result's `_meta`,
which is protocol metadata and reaches no model, so `content[0].text` is **byte-identical**
whether or not your host renders widgets — the token cost of a series is the same either way.
That is deliberate: `structuredContent` would have been the obvious home for it, but core MCP
treats that field as server-produced result data, and a host without Apps support may hand it
to the model, doubling the cost of a large series.

The chart is one self-contained HTML file with uPlot and all CSS inlined, because MCP Apps
render under a deny-by-default CSP where an external `<script>` would simply never load. It is
read-only and never calls back into the server: it draws the points it was given and cannot
spend your row quota behind your back. Series longer than 2,000 points are decimated **for the
chart only** — the tool still returns every point — and the payload says so rather than
quietly thinning the line.

## Data quality

When the API reports a row's measurement quality, `blackforge_latest` carries it through as a
`quality` object (`flags` naming what went wrong in the window, `contaminates` listing which
figures it flags) plus a plain-English `qualityNote`. `blackforge_series`
aggregates it into one `qualitySummary` (`{ flaggedBuckets, of, flags }`) rather than repeating
it on every point. Both keys are **omitted entirely** when nothing is flagged, and a
`quality.raw` of `32768` means the row predates the quality rail and was never assessed —
unknown, not bad. The flag decode table lives on the `qualityFlags` metric in
`blackforge_catalog`, as a `bits` array; this server reads it from there and never carries a
copy of its own.

## Configuration

| Env var | Default | Purpose |
|---------|---------|---------|
| `BLACKFORGE_API_KEY` | *(none)* | Your key. Required for every tool except `blackforge_catalog`. |
| `BLACKFORGE_BASE_URL` | `https://api.blackforge.so` | API base. Paths are appended as `/v1/...`. Override for a self-hosted or local dev API (e.g. `http://localhost:3001/api`). |
| `BLACKFORGE_REALTIME_URL` | `https://realtime.blackforge.so` | Realtime host for the live formula stream and the live order book reads. |

## Local development

```bash
npm install
npm run build     # → dist/index.js (ESM, executable) + dist/widget/chart.html
npm test          # client unit tests + a stdio integration test
```

`build` runs tsup first and the widget's vite build second, and the order is load-bearing:
tsup's `clean` wipes the whole of `dist/`, so reversing them deletes the widget and leaves the
server serving a resource that is not there.

The integration test spawns the built server over stdio and drives it with the MCP client.
Its data assertions need a local BlackForge API at `http://localhost:3001/api`; without one,
those assertions are skipped and the tool-listing checks still run.

## License

MIT
