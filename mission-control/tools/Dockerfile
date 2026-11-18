# Mission Control tools service: runs the MCP servers in tools.json for the agents.
# Tools are installed here at build time with fixed versions (never while running), so
# adding one is a deliberate rebuild. At runtime it has internet for the tools, but
# none of your files and none of Mission Control's keys; only the harness can reach it.
FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Tool programs go here (one RUN per tool, pinned), for example a printed CLI's MCP server:
#   RUN npm install -g some-mcp-server@1.2.3

COPY server.mjs demo-server.mjs test.mjs ./
RUN useradd -m mctools && chown -R mctools /app
USER mctools
ENV PORT=3040 NODE_ENV=production
EXPOSE 3040
CMD ["node", "server.mjs"]
