# Installing the BlackForge MCP server

Notes for AI agents (Cline and others) that set this server up for a user.

## What it is

A stdio MCP server, published on npm as `@blackforge-so/mcp`. It gives the agent real time
crypto market data from the major exchanges: order book depth, liquidity added and pulled,
order ladders and what actually traded, 150+ metrics for 14,000+ pairs, plus the linear futures
contracts on the major futures venues: funding, open interest, prices, taker flow and
liquidations.

## Requirements

- Node.js 20 or newer (`node --version`). Only `blackforge_formula_watch` needs Node 22 or newer.
- Nothing to clone and nothing to build. `npx -y @blackforge-so/mcp` downloads and runs the
  published package on demand, so no server directory is needed.

## Steps

1. Read the user's existing MCP settings file (for Cline, `cline_mcp_settings.json`) and keep
   every server already in it.
2. Add this entry under `mcpServers`:

   ```json
   "github.com/blackforge-so/mcp": {
     "command": "npx",
     "args": ["-y", "@blackforge-so/mcp"],
     "env": { "BLACKFORGE_API_KEY": "" },
     "disabled": false,
     "autoApprove": []
   }
   ```

3. Ask the user for their BlackForge API key and put it in `BLACKFORGE_API_KEY`. Keys are
   created at https://app.blackforge.so/api (there is a free plan). If the user has no key yet,
   leave the value empty: the server still starts, and `blackforge_catalog` works without a key.
4. Verify the install by calling `blackforge_catalog` with no arguments. It returns every venue
   and every metric definition, plus `metricCount`. If it answers, the server is installed.
5. With a key set, try `blackforge_latest` with `{"exchange": "binance", "symbol": "BTCUSDT"}`,
   and for futures `blackforge_futures_latest` with the same arguments.

## If something fails

- An error saying `BLACKFORGE_API_KEY is not set`: every tool except `blackforge_catalog` needs a
  key. Add it to the `env` block and restart the server.
- An error carrying an HTTP status and an upgrade URL: the key's plan does not include that
  venue, column or interval. The README's tool tables list which tools need which plan.
