import { homedir } from "node:os";
import { join } from "node:path";

/** Per-user data directory. MURMUR_HOME overrides it (tests, portable installs). */
export function dataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.MURMUR_HOME) return env.MURMUR_HOME;
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "Murmur");
  if (platform === "win32") return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Murmur");
  return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "murmur");
}

/** Config files (mcp.json) live next to the database. */
export const configDir = dataDir;

export const databasePath = (env?: NodeJS.ProcessEnv) => join(dataDir(env), "murmur.db");
export const mcpConfigPath = (env?: NodeJS.ProcessEnv) => join(configDir(env), "mcp.json");
