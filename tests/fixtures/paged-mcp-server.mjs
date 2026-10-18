import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "paged-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async ({ params }) => {
  const page = params?.cursor === undefined ? "first" : "second";
  return {
    tools: [{ name: page, description: page, inputSchema: { type: "object" } }],
    ...(page === "first" ? { nextCursor: "second-page" } : {}),
  };
});
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({
  content: [{ type: "text", text: `called ${params.name}` }],
}));
await server.connect(new StdioServerTransport());
