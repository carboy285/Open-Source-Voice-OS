import type { SecretStore } from "../secrets/store.js";
import {
  forgetSecrets,
  isHttp,
  loadConfig,
  parseAddArgs,
  protectSecrets,
  saveConfig,
  SERVER_NAME,
  UsageError,
  type ServerConfig,
} from "./config.js";
import { McpManager, type ConnectionFactory } from "./manager.js";

export interface McpCliDeps {
  configPath: string;
  secrets: SecretStore;
  out: (line: string) => void;
  /** Used by `list mcp` to check each server. */
  factory?: ConnectionFactory;
  probeTimeoutMs?: number;
}

export const MCP_USAGE = `Usage:
  murmur add mcp <name> [--env KEY=VALUE]... -- <command> [args...]
  murmur add mcp <name> --url <https-url> [--header KEY=VALUE]...
  murmur list mcp
  murmur remove mcp <name>`;

/** Handles `add|list|remove mcp`. Returns the process exit code. */
export async function runMcpCli(verb: string, argv: string[], deps: McpCliDeps): Promise<number> {
  try {
    if (verb === "add") return await add(argv, deps);
    if (verb === "list") return await list(deps);
    if (verb === "remove") return await remove(argv, deps);
    throw new UsageError(`Unknown command ${verb}`);
  } catch (error) {
    if (error instanceof UsageError) {
      deps.out(`${error.message}\n\n${MCP_USAGE}`);
      return 2;
    }
    deps.out(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function add(argv: string[], deps: McpCliDeps): Promise<number> {
  const { name, server } = parseAddArgs(argv);
  const config = await loadConfig(deps.configPath);
  const previous = config.servers[name];
  if (previous) await forgetSecrets(previous, deps.secrets);
  config.servers[name] = await protectSecrets(name, server, deps.secrets);
  await saveConfig(deps.configPath, config);
  const moved = countRefs(config.servers[name]!);
  deps.out(`${previous ? "Updated" : "Added"} MCP server "${name}" (${describe(server)}).`);
  if (moved) deps.out(`Stored ${moved} secret value${moved > 1 ? "s" : ""} in the keychain.`);
  deps.out(
    "Run `murmur list mcp` to connect and check it now. The Murmur app picks it up when it restarts, or when you click Retry in Settings › Connectors.",
  );
  return 0;
}

async function list(deps: McpCliDeps): Promise<number> {
  const config = await loadConfig(deps.configPath);
  const names = Object.keys(config.servers).sort();
  if (!names.length) {
    deps.out("No MCP servers yet. Add one with: murmur add mcp <name> -- <command>");
    return 0;
  }
  const manager = new McpManager({ secrets: deps.secrets, factory: deps.factory, maxRetryMs: 1 << 30 });
  await Promise.race([
    manager.start(config),
    new Promise((resolve) => setTimeout(resolve, deps.probeTimeoutMs ?? 10_000).unref()),
  ]);
  const status = new Map(manager.status().map((s) => [s.name, s]));
  for (const name of names) {
    const server = config.servers[name]!;
    const s = status.get(name);
    const state = !server.enabled
      ? "disabled"
      : s?.state === "connected"
        ? `connected, ${s.tools} tool${s.tools === 1 ? "" : "s"}`
        : s?.state === "error"
          ? `error: ${s.error ?? "unknown"}`
          : "not responding";
    deps.out(`${name.padEnd(16)} ${state.padEnd(28)} ${describe(server)}`);
  }
  await manager.close();
  return 0;
}

async function remove(argv: string[], deps: McpCliDeps): Promise<number> {
  const name = argv[0];
  if (!name || !SERVER_NAME.test(name)) throw new UsageError("Give the name of the server to remove.");
  const config = await loadConfig(deps.configPath);
  const server = config.servers[name];
  if (!server) {
    deps.out(`No MCP server named "${name}".`);
    return 1;
  }
  await forgetSecrets(server, deps.secrets);
  delete config.servers[name];
  await saveConfig(deps.configPath, config);
  deps.out(`Removed MCP server "${name}".`);
  return 0;
}

function describe(server: ServerConfig): string {
  return isHttp(server) ? server.url : [server.command, ...server.args].join(" ");
}

function countRefs(server: ServerConfig): number {
  return Object.values(isHttp(server) ? server.headers : server.env).filter((v) => v.startsWith("keychain:")).length;
}
