# BlackForge MCP server (stdio). Built from this repository's source.
#
#   docker build -t blackforge-mcp .
#   docker run -i --rm -e BLACKFORGE_API_KEY=bf_live_your_key blackforge-mcp
#
# Node 22: blackforge_formula_watch uses Node's built-in WebSocket.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsup.config.ts vite.widget.config.ts ./
COPY src ./src
COPY widget ./widget
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
ENTRYPOINT ["node", "dist/index.js"]
