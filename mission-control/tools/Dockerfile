# Mission Control tools service: runs the MCP servers in tools.json for the agents.
# Tools are installed here at build time with fixed versions (never while running), so
# adding one is a deliberate rebuild. At runtime it has internet for the tools, but
# none of your files and none of Mission Control's keys (only the keys in tools/.env, and
# Mission Control's own committed code through a read-only mount of the repository's .git
# folder for the code tools); only the harness can reach it.

# --- ESPN (CLI Printing Press library), built from a reviewed commit -----------------
# Reviewed 2026-11-18 at printing-press-library c0e8760: calls only ESPN's API hosts;
# its feedback upload is off unless ESPN_FEEDBACK_ENDPOINT is set (it never is here);
# the MCP server runs only its own companion CLI.
FROM golang:1.26-bookworm AS espn
ARG PPL_COMMIT=c0e8760256d7f62055b9f4322b94f5fb089f6d2f
ENV CGO_ENABLED=0 GOFLAGS=-trimpath GOTOOLCHAIN=auto
RUN go install github.com/mvanhorn/printing-press-library/library/media-and-entertainment/espn/cmd/espn-pp-mcp@${PPL_COMMIT} \
 && go install github.com/mvanhorn/printing-press-library/library/media-and-entertainment/espn/cmd/espn-pp-cli@${PPL_COMMIT}

# --- GitHub's official MCP server, a fixed release ------------------------------------
# v2.1.0 (2026-11-03, tag commit 7c48164). Runs read-only (--read-only in tools.json) with a
# fine-grained token from tools/.env; it calls only the GitHub API.
ARG GITHUB_MCP_VERSION=v2.1.0
RUN go install -ldflags "-X main.version=${GITHUB_MCP_VERSION}" github.com/github/github-mcp-server/v2/cmd/github-mcp-server@${GITHUB_MCP_VERSION}

# --- The service --------------------------------------------------------------------
FROM node:22-bookworm-slim

# The system's certificate store: Go programs (ESPN, GitHub) check HTTPS against it; Node has
# its own. git: the code tools read the repository with it.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY --from=espn /go/bin/espn-pp-mcp /go/bin/espn-pp-cli /go/bin/github-mcp-server /usr/local/bin/

COPY server.mjs demo-server.mjs wikipedia-server.mjs brave-server.mjs images-server.mjs code-server.mjs test.mjs ./
RUN useradd -m mctools && chown -R mctools /app
USER mctools
ENV PORT=3040 NODE_ENV=production
EXPOSE 3040
CMD ["node", "server.mjs"]
