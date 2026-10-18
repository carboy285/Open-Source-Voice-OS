import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fixture", version: "1.0.0" });
server.registerTool(
  "echo",
  { description: "Echo text", inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
  async ({ text }) => ({ content: [{ type: "text", text: `echo:${text}` }] }),
);
server.registerTool(
  "send",
  { description: "Send a message", inputSchema: { to: z.string() } },
  async ({ to }) => ({ content: [{ type: "text", text: `sent to ${to}` }] }),
);
server.registerTool("boom", { description: "Always fails", inputSchema: {} }, async () => ({
  isError: true,
  content: [{ type: "text", text: "kaboom" }],
}));
await server.connect(new StdioServerTransport());
