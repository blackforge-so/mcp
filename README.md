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

## Local development

```bash
npm install
npm run build     # → dist/index.js (ESM, executable)
npm test          # client unit tests + a stdio integration test
```

The integration test spawns the built server over stdio and drives it with the MCP client.
Its data assertions need a local BlackForge API at `http://localhost:3001/api`; without one,
those assertions are skipped and the tool-listing checks still run.

## License

MIT
