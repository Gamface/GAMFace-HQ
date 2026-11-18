// A tiny MCP server for testing the tools service: two read-only tools and one that
// says it would change something (it doesn't), so the read-only rule can be checked.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "demo", version: "1.0.0" });

server.registerTool(
  "echo",
  { description: "Repeats the text back", inputSchema: { text: z.string().describe("What to repeat") }, annotations: { readOnlyHint: true } },
  async ({ text }) => ({ content: [{ type: "text", text }] }),
);

server.registerTool(
  "time",
  { description: "The current date and time in UTC", inputSchema: {}, annotations: { readOnlyHint: true } },
  async () => ({ content: [{ type: "text", text: new Date().toISOString() }] }),
);

server.registerTool(
  "add_note",
  { description: "Saves a note (pretend: nothing is stored)", inputSchema: { text: z.string() }, annotations: { readOnlyHint: false, destructiveHint: false } },
  async ({ text }) => ({ content: [{ type: "text", text: `Would have saved: ${text}` }] }),
);

await server.connect(new StdioServerTransport());
