import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isSecretRef, looksSecret, refKey, secretRef, type SecretStore } from "../secrets/store.js";

export interface StdioServer {
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
}

export interface HttpServer {
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
}

export type ServerConfig = StdioServer | HttpServer;

export interface McpConfig {
  servers: Record<string, ServerConfig>;
}

export const SERVER_NAME = /^[a-z0-9-]{1,32}$/;
export const isHttp = (s: ServerConfig): s is HttpServer => "url" in s;

export async function loadConfig(path: string): Promise<McpConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { servers: {} };
    throw error;
  }
  const parsed = JSON.parse(text) as Partial<McpConfig>;
  return { servers: parsed.servers ?? {} };
}

/** Writes atomically, readable only by the user. */
export async function saveConfig(path: string, config: McpConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

export class UsageError extends Error {}

function pair(raw: string | undefined, flag: string): [string, string] {
  const eq = raw?.indexOf("=") ?? -1;
  if (!raw || eq <= 0) throw new UsageError(`${flag} needs KEY=VALUE, got "${raw ?? ""}"`);
  return [raw.slice(0, eq), raw.slice(eq + 1)];
}

/**
 * Parses the arguments after `murmur add mcp`:
 *   <name> [--env K=V]... -- <command> [args...]
 *   <name> --url <https-url> [--header K=V]...
 */
export function parseAddArgs(argv: string[]): { name: string; server: ServerConfig } {
  const dash = argv.indexOf("--");
  const head = dash >= 0 ? argv.slice(0, dash) : argv;
  const command = dash >= 0 ? argv.slice(dash + 1) : [];
  let name: string | undefined;
  let url: string | undefined;
  let enabled = true;
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};

  for (let i = 0; i < head.length; i++) {
    const arg = head[i]!;
    if (arg === "--url") url = head[++i];
    else if (arg.startsWith("--url=")) url = arg.slice(6);
    else if (arg === "--env" || arg === "-e") {
      const [k, v] = pair(head[++i], "--env");
      env[k] = v;
    } else if (arg === "--header" || arg === "-H") {
      const [k, v] = pair(head[++i], "--header");
      headers[k] = v;
    } else if (arg === "--disabled") enabled = false;
    else if (arg.startsWith("-")) throw new UsageError(`Unknown option ${arg}`);
    else if (name === undefined) name = arg;
    else throw new UsageError(`Unexpected argument "${arg}". Put the server command after --`);
  }

  if (!name) throw new UsageError("Give the server a name: murmur add mcp <name> -- <command>");
  if (!SERVER_NAME.test(name)) throw new UsageError(`"${name}" is not a valid name. Use 1–32 of a-z, 0-9 and -.`);
  if (url !== undefined && command.length) throw new UsageError("Use either --url or a command after --, not both.");
  if (url !== undefined) {
    if (Object.keys(env).length) throw new UsageError("--env applies to command servers only.");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new UsageError(`"${url}" is not a valid URL.`);
    }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && local)) {
      throw new UsageError("Remote servers need an https:// URL.");
    }
    return { name, server: { url: parsed.toString(), headers, enabled } };
  }
  if (!command.length) throw new UsageError("Add the server command after --, or use --url.");
  if (Object.keys(headers).length) throw new UsageError("--header applies to --url servers only.");
  return { name, server: { command: command[0]!, args: command.slice(1), env, enabled } };
}

const isSecretName = (name: string) => looksSecret(name) || /^authorization$/i.test(name);

/** Moves secret-looking env and header values into the keychain, leaving references behind. */
export async function protectSecrets(name: string, server: ServerConfig, secrets: SecretStore): Promise<ServerConfig> {
  const move = async (kind: "env" | "header", values: Record<string, string>) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) {
      if (isSecretName(k) && !isSecretRef(v)) {
        const key = `mcp/${name}/${kind}/${k}`;
        await secrets.set(key, v);
        out[k] = secretRef(key);
      } else out[k] = v;
    }
    return out;
  };
  return isHttp(server)
    ? { ...server, headers: await move("header", server.headers) }
    : { ...server, env: await move("env", server.env) };
}

/** Replaces keychain references with their values, for connecting. */
export async function resolveSecrets(server: ServerConfig, secrets: SecretStore): Promise<ServerConfig> {
  const resolve = async (values: Record<string, string>) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) {
      if (!isSecretRef(v)) {
        out[k] = v;
        continue;
      }
      const value = await secrets.get(refKey(v));
      if (value === undefined) throw new Error(`The keychain has no value for ${k}. Add the server again.`);
      out[k] = value;
    }
    return out;
  };
  return isHttp(server)
    ? { ...server, headers: await resolve(server.headers) }
    : { ...server, env: await resolve(server.env) };
}

export async function forgetSecrets(server: ServerConfig, secrets: SecretStore): Promise<void> {
  const values = isHttp(server) ? server.headers : server.env;
  for (const v of Object.values(values)) if (isSecretRef(v)) await secrets.delete(refKey(v));
}
