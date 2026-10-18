import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { bundledBinDir } from "../core/paths.js";

/** Folders searched for a bare binary name after the app's own bin folder. Apps opened from Finder don't get Homebrew on PATH. */
export const BINARY_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves a bare name like "parakeet-cli" to a full path: the binaries shipped inside Murmur first,
 * then Homebrew folders, then PATH. A value containing a slash is used as is.
 */
export function resolveBinary(
  name: string,
  envPath = process.env.PATH ?? "",
  exists: (path: string) => boolean = isExecutable,
  bundled: string = bundledBinDir(),
): string {
  if (!name || name.includes("/") || name.includes("\\")) return name;
  const dirs = [bundled, ...BINARY_DIRS, ...envPath.split(delimiter).filter(Boolean)];
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return name;
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a speech CLI with the audio on stdin. Rejects only when the process can't start or times out. */
export function runCli(name: string, args: string[], input: Buffer, timeoutMs: number): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const binary = resolveBinary(name);
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Speech recognition timed out."));
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (error) => {
      clearTimeout(timer);
      const searched = binary === name ? ` (looked in Murmur's bin folder, ${BINARY_DIRS.join(", ")} and PATH)` : "";
      reject(new Error(`Could not start ${name}${searched}: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
