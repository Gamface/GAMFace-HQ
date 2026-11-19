# Mission Control tools service: runs the MCP servers in tools.json for the agents.
# Tools are installed here at build time with fixed versions (never while running), so
# adding one is a deliberate rebuild. At runtime it has internet for the tools, but
# none of your files and none of Mission Control's keys; only the harness can reach it.

# --- ESPN (CLI Printing Press library), built from a reviewed commit -----------------
# Reviewed 2026-11-18 at printing-press-library c0e8760: calls only ESPN's API hosts;
# its feedback upload is off unless ESPN_FEEDBACK_ENDPOINT is set (it never is here);
# the MCP server runs only its own companion CLI.
FROM golang:1.26-bookworm AS espn
ARG PPL_COMMIT=c0e8760256d7f62055b9f4322b94f5fb089f6d2f
ENV CGO_ENABLED=0 GOFLAGS=-trimpath GOTOOLCHAIN=auto
RUN go install github.com/mvanhorn/printing-press-library/library/media-and-entertainment/espn/cmd/espn-pp-mcp@${PPL_COMMIT} \
 && go install github.com/mvanhorn/printing-press-library/library/media-and-entertainment/espn/cmd/espn-pp-cli@${PPL_COMMIT}

# --- The service --------------------------------------------------------------------
FROM node:22-bookworm-slim

# The system's certificate store: Go programs (ESPN) check HTTPS against it; Node has its own
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY --from=espn /go/bin/espn-pp-mcp /go/bin/espn-pp-cli /usr/local/bin/

COPY server.mjs demo-server.mjs wikipedia-server.mjs brave-server.mjs images-server.mjs test.mjs ./
RUN useradd -m mctools && chown -R mctools /app
USER mctools
ENV PORT=3040 NODE_ENV=production
EXPOSE 3040
CMD ["node", "server.mjs"]
