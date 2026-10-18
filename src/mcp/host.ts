import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import type { ToolHost, ToolSpec } from "../core/types.js";

const ServerConfig = z.object({
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
});

export const McpConfig = z.object({ servers: z.record(z.string(), ServerConfig) });
export type McpConfig = z.infer<typeof McpConfig>;

const SEPARATOR = "__";

export async function loadMcpConfig(path: string): Promise<McpConfig> {
  return McpConfig.parse(JSON.parse(await readFile(path, "utf8")));
}

interface Connected {
  name: string;
  client: Client;
}

/**
 * Exposes the tools of several MCP servers as one flat list, namespaced `server__tool`.
 * A tool counts as read-only only if its server says so (annotations.readOnlyHint);
 * everything else is treated as side-effecting and needs confirmation.
 */
export class McpToolHost implements ToolHost {
  private constructor(private readonly servers: Connected[]) {}

  static async connect(config: McpConfig): Promise<McpToolHost> {
    const servers: Connected[] = [];
    try {
      for (const [name, server] of Object.entries(config.servers)) {
        const client = new Client({ name: "voiceos", version: "0.1.0" });
        const env = { ...(process.env as Record<string, string>), ...server.env };
        await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env }));
        servers.push({ name, client });
      }
    } catch (error) {
      await Promise.allSettled(servers.map((s) => s.client.close()));
      throw error;
    }
    return new McpToolHost(servers);
  }

  async list(): Promise<ToolSpec[]> {
    const specs: ToolSpec[] = [];
    for (const { name, client } of this.servers) {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        specs.push({
          name: `${name}${SEPARATOR}${tool.name}`.slice(0, 64),
          description: tool.description ?? "",
          inputSchema: tool.inputSchema as Record<string, unknown>,
          readOnly: tool.annotations?.readOnlyHint === true,
        });
      }
    }
    return specs;
  }

  async call(name: string, input: Record<string, unknown>): Promise<string> {
    const index = name.indexOf(SEPARATOR);
    const server = this.servers.find((s) => s.name === name.slice(0, index));
    if (index < 0 || !server) throw new Error(`Unknown tool: ${name}`);
    // The 64-char limit on names can truncate; resolve back through the server's own list.
    const { tools } = await server.client.listTools();
    const prefix = name.slice(index + SEPARATOR.length);
    const tool = tools.find((t) => t.name === prefix || `${server.name}${SEPARATOR}${t.name}`.slice(0, 64) === name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    const result = await server.client.callTool({ name: tool.name, arguments: input });
    const text = (Array.isArray(result.content) ? result.content : [])
      .flatMap((block: { type: string; text?: string }) => (block.type === "text" && block.text ? [block.text] : []))
      .join("\n");
    if (result.isError) throw new Error(text || "Tool call failed.");
    return text;
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.servers.map((s) => s.client.close()));
  }
}
