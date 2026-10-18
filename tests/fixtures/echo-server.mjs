// Minimal MCP server over stdio for tests: one read-only tool and one unannotated tool.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo", version: "1.0.0" });
server.registerTool(
  "echo",
  { description: "Echo text back", inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
  async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
);
server.registerTool(
  "write",
  { description: "Pretend to write", inputSchema: { path: z.string() } },
  async ({ path }) => ({
    content: [
      { type: "text", text: `wrote ${path}` },
      { type: "image", data: "", mimeType: "image/png" },
    ],
  }),
);
await server.connect(new StdioServerTransport());
