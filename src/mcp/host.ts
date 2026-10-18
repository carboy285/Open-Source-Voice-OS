import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
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
  private routes: Map<string, { client: Client; toolName: string }> | undefined;

  private constructor(private readonly servers: Connected[]) {}

  static async connect(config: McpConfig): Promise<McpToolHost> {
    const servers: Connected[] = [];
    try {
      for (const [name, server] of Object.entries(config.servers)) {
        const client = new Client({ name: "voiceos", version: "0.1.0" });
        const env = { ...(process.env as Record<string, string>), ...server.env };
        servers.push({ name, client });
        await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env }));
      }
    } catch (error) {
      await Promise.allSettled(servers.map((s) => s.client.close()));
      throw error;
    }
    return new McpToolHost(servers);
  }

  async list(): Promise<ToolSpec[]> {
    this.routes = undefined;
    const entries: Array<{ server: Connected; tool: Tool; fullName: string }> = [];
    const counts = new Map<string, number>();
    for (const server of this.servers) {
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      const seenTools = new Set<string>();
      do {
        const page = await server.client.listTools(cursor === undefined ? {} : { cursor });
        for (const tool of page.tools) {
          if (seenTools.has(tool.name)) throw new Error(`Duplicate MCP tool: ${server.name}${SEPARATOR}${tool.name}`);
          seenTools.add(tool.name);
          const fullName = `${server.name}${SEPARATOR}${tool.name}`;
          entries.push({ server, tool, fullName });
          counts.set(fullName, (counts.get(fullName) ?? 0) + 1);
        }
        cursor = page.nextCursor;
        if (cursor !== undefined) {
          if (seenCursors.has(cursor)) throw new Error(`MCP server "${server.name}" repeated a tools cursor.`);
          seenCursors.add(cursor);
        }
      } while (cursor !== undefined);
    }

    const routes = new Map<string, { client: Client; toolName: string }>();
    const specs: ToolSpec[] = [];
    for (const { server, tool, fullName } of entries) {
      let name = fullName;
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || counts.get(fullName)! > 1) {
        const hash = createHash("sha256").update(JSON.stringify([server.name, tool.name])).digest("hex").slice(0, 16);
        name = `${fullName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 47)}_${hash}`;
      }
      if (routes.has(name)) throw new Error(`MCP tool name collision: ${name}`);
      routes.set(name, { client: server.client, toolName: tool.name });
      specs.push({
        name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema as Record<string, unknown>,
        readOnly: tool.annotations?.readOnlyHint === true,
      });
    }
    this.routes = routes;
    return specs;
  }

  async call(name: string, input: Record<string, unknown>): Promise<string> {
    if (!this.routes) await this.list();
    const route = this.routes!.get(name);
    if (!route) throw new Error(`Unknown tool: ${name}`);
    const result = await route.client.callTool({ name: route.toolName, arguments: input });
    const text = (Array.isArray(result.content) ? result.content : [])
      .flatMap((block: { type: string; text?: string }) => (block.type === "text" && block.text ? [block.text] : []))
      .join("\n");
    if (result.isError) throw new Error(text || "Tool call failed.");
    return text;
  }

  async close(): Promise<void> {
    this.routes = undefined;
    await Promise.allSettled(this.servers.map((s) => s.client.close()));
  }
}
