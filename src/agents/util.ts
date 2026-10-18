import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { Detection } from "./types.js";

/** Where agent CLIs usually live. A Mac app opened from Finder does not get the shell's PATH. */
export function agentDirs(env = process.env, home = homedir()): string[] {
  return [
    join(home, ".local", "bin"),
    join(home, ".opencode", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".npm-global", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ...(env.PATH ?? "").split(delimiter).filter(Boolean),
  ];
}

const isExecutable = (path: string) => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export function findBinary(name: string, dirs = agentDirs(), exists = isExecutable): string | undefined {
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/** Runs `<binary> --version` with a short timeout. */
export function versionOf(path: string, timeoutMs = 5000): Promise<string | undefined> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(path, ["--version"], { stdio: ["ignore", "pipe", "ignore"], timeout: timeoutMs });
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("error", () => resolve(undefined));
    child.on("close", () => resolve(out.trim().split("\n")[0]?.slice(0, 80) || undefined));
  });
}

export async function detectBinary(name: string, hint?: string): Promise<Detection> {
  const path = findBinary(name);
  if (!path) return { installed: false, hint: `${name} isn't installed.` };
  return { installed: true, path, version: await versionOf(path), hint };
}

/** Newline-delimited JSON from a child process's stdout. */
export function readLines(child: ChildProcess, onLine: (line: string) => void): void {
  let buffer = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onLine(line);
    }
  });
}

export const parseJson = (line: string): Record<string, unknown> | undefined => {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

export const asString = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
export const asObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Stops a child: politely, then for sure. */
export function terminate(child: ChildProcess, graceMs = 1500): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.killed) return resolve();
    const hard = setTimeout(() => child.kill("SIGKILL"), graceMs);
    child.once("close", () => {
      clearTimeout(hard);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

const RISKY = [
  /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i,
  /\bsudo\b/,
  /\bgit\s+push\b.*(--force|-f\b)/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\b.*-[a-z]*f/,
  /\bchmod\s+-R\b/,
  /\bmkfs\b|\bdd\s+if=/,
  /\bcurl\b[^|]*\|\s*(ba|z)?sh\b/,
  /\bdrop\s+(table|database)\b/i,
  />\s*\/dev\/(sd|disk)/,
];

/** A command that could do real damage. It gets a second confirmation in the notch. */
export const isRiskyCommand = (command: string): boolean => RISKY.some((pattern) => pattern.test(command));
