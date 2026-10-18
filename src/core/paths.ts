import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

/** Downloaded speech models. */
export const modelsDir = (env?: NodeJS.ProcessEnv) => join(dataDir(env), "models");

/**
 * Speech CLIs shipped with the app: Murmur.app/Contents/Resources/core/bin, next to the bundled core.
 * MURMUR_BIN_DIR overrides it.
 */
export function bundledBinDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MURMUR_BIN_DIR) return env.MURMUR_BIN_DIR;
  return join(dirname(fileURLToPath(import.meta.url)), "bin");
}
