import type { McpToolAnnotations, ToolHost, ToolSpec } from "../core/types.js";
import { isHttp, resolveSecrets, type McpConfig, type ServerConfig } from "./config.js";
import type { SecretStore } from "../secrets/store.js";
import { WireNames } from "../providers/wire-names.js";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

export interface McpContent {
  type: string;
  text?: string;
}

export interface McpCallResult {
  content?: McpContent[];
  isError?: boolean;
}

/** One live server connection. The default implementation wraps the MCP SDK client. */
export interface McpConnection {
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<McpCallResult>;
  onToolsChanged(handler: () => void): void;
  onClose(handler: () => void): void;
  close(): Promise<void>;
}

export type ConnectionFactory = (name: string, server: ServerConfig) => Promise<McpConnection>;

export type ServerState = "connecting" | "connected" | "error" | "disabled";

export interface ServerStatus {
  name: string;
  state: ServerState;
  tools: number;
  error?: string;
  transport: "stdio" | "http";
}

interface Entry {
  server: ServerConfig;
  state: ServerState;
  tools: McpTool[];
  error?: string;
  connection?: McpConnection;
  retryMs: number;
  timer?: ReturnType<typeof setTimeout>;
}

export interface McpManagerOptions {
  secrets: SecretStore;
  factory?: ConnectionFactory;
  callTimeoutMs?: number;
  /** Backoff bounds for reconnects. */
  minRetryMs?: number;
  maxRetryMs?: number;
  onChange?: () => void;
}

/** Connects to enabled MCP servers and exposes their tools as `mcp.<server>.<tool>`. */
export class McpManager implements ToolHost {
  private readonly entries = new Map<string, Entry>();
  private catalog?: { specs: ToolSpec[]; routes: Map<string, { server: string; tool: string; entry: Entry }> };
  private closed = false;

  constructor(private readonly options: McpManagerOptions) {}

  async start(config: McpConfig): Promise<void> {
    await Promise.all(Object.entries(config.servers).map(([name, server]) => this.add(name, server)));
  }

  async add(name: string, server: ServerConfig): Promise<void> {
    await this.remove(name);
    const entry: Entry = {
      server,
      state: server.enabled ? "connecting" : "disabled",
      tools: [],
      retryMs: this.minRetry,
    };
    this.entries.set(name, entry);
    this.catalog = undefined;
    if (server.enabled) await this.connect(name, entry);
  }

  async remove(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (!entry) return;
    this.entries.delete(name);
    this.catalog = undefined;
    if (entry.timer) clearTimeout(entry.timer);
    await entry.connection?.close().catch(() => {});
  }

  status(): ServerStatus[] {
    return [...this.entries].map(([name, e]) => ({
      name,
      state: e.state,
      tools: e.tools.length,
      error: e.error,
      transport: isHttp(e.server) ? "http" : "stdio",
    }));
  }

  async list(): Promise<ToolSpec[]> {
    return this.toolCatalog().specs;
  }

  private toolCatalog() {
    if (this.catalog) return this.catalog;
    const specs: ToolSpec[] = [];
    const routes = new Map<string, { server: string; tool: string; entry: Entry }>();
    const names = new WireNames();
    for (const [server, entry] of this.entries) {
      if (entry.state !== "connected") continue;
      for (const tool of entry.tools) {
        const name = `mcp.${server}.${tool.name}`;
        if (routes.has(name)) throw new Error(`Duplicate MCP tool: ${name}`);
        const route = { server, tool: tool.name, entry };
        routes.set(name, route);
        routes.set(names.wire(name), route);
        specs.push({
          name,
          description: `[${server}] ${tool.description ?? tool.name}`,
          inputSchema: tool.inputSchema ?? { type: "object" },
          origin: "mcp",
          annotations: tool.annotations,
        });
      }
    }
    this.catalog = { specs, routes };
    return this.catalog;
  }

  async call(name: string, input: Record<string, unknown>): Promise<string> {
    const route = this.toolCatalog().routes.get(name);
    const entry = route?.entry;
    if (!route || !entry?.connection || entry.state !== "connected" || this.entries.get(route.server) !== entry)
      throw new Error(`MCP server for ${name} is not connected.`);
    const result = await entry.connection.callTool(route.tool, input, this.options.callTimeoutMs ?? 60_000);
    const text = formatContent(result.content ?? []);
    if (result.isError) throw new Error(text || "The MCP tool reported an error.");
    return text;
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.entries.keys()].map((name) => this.remove(name)));
  }

  private get minRetry() {
    return this.options.minRetryMs ?? 1000;
  }

  private async connect(name: string, entry: Entry): Promise<void> {
    if (this.closed || this.entries.get(name) !== entry) return;
    entry.state = "connecting";
    this.catalog = undefined;
    try {
      const resolved = await resolveSecrets(entry.server, this.options.secrets);
      const connection = await (this.options.factory ?? sdkConnection)(name, resolved);
      entry.connection = connection;
      entry.tools = await connection.listTools();
      entry.state = "connected";
      this.catalog = undefined;
      entry.error = undefined;
      entry.retryMs = this.minRetry;
      connection.onToolsChanged(() => {
        connection
          .listTools()
          .then((tools) => {
            entry.tools = tools;
            this.catalog = undefined;
            this.options.onChange?.();
          })
          .catch(() => {});
      });
      connection.onClose(() => {
        if (this.entries.get(name) !== entry || this.closed) return;
        entry.state = "error";
        entry.error = "Disconnected";
        entry.tools = [];
        this.catalog = undefined;
        this.scheduleRetry(name, entry);
      });
    } catch (error) {
      await entry.connection?.close().catch(() => {});
      entry.connection = undefined;
      entry.state = "error";
      entry.error = error instanceof Error ? error.message : String(error);
      entry.tools = [];
      this.catalog = undefined;
      this.scheduleRetry(name, entry);
    }
    this.options.onChange?.();
  }

  private scheduleRetry(name: string, entry: Entry): void {
    if (this.closed || entry.timer) return;
    const delay = entry.retryMs;
    entry.retryMs = Math.min(entry.retryMs * 2, this.options.maxRetryMs ?? 60_000);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.connect(name, entry);
    }, delay);
    entry.timer.unref?.();
  }
}

/** Joins text content; other content types are named but not passed through. */
export function formatContent(content: McpContent[]): string {
  return content
    .map((c) => (c.type === "text" ? (c.text ?? "") : c.type === "image" ? "[image]" : "[unsupported content]"))
    .join("\n");
}

const sdkConnection: ConnectionFactory = async (_name, server) => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { ToolListChangedNotificationSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const client = new Client({ name: "murmur", version: "0.1.0" });
  let transport;
  if (isHttp(server)) {
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } });
  } else {
    const { StdioClientTransport, getDefaultEnvironment } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: { ...getDefaultEnvironment(), ...server.env },
      stderr: "ignore",
    });
  }
  await client.connect(transport);
  return {
    async listTools() {
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        for (const t of page.tools) {
          tools.push({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema as Record<string, unknown>,
            annotations: t.annotations as McpToolAnnotations | undefined,
          });
        }
        cursor = page.nextCursor;
        if (cursor) {
          if (seen.has(cursor)) throw new Error(`MCP server "${_name}" repeated a tools cursor.`);
          seen.add(cursor);
        }
      } while (cursor);
      return tools;
    },
    async callTool(tool, args, timeoutMs) {
      const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: timeoutMs });
      return result as McpCallResult;
    },
    onToolsChanged(handler) {
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => handler());
    },
    onClose(handler) {
      client.onclose = handler;
    },
    close: () => client.close(),
  };
};
