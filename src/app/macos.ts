import { execFile } from "node:child_process";
import type { TextInjector } from "../core/types.js";

/** Runs a command and returns stdout. Replaceable so the macOS logic is testable off a Mac. */
export type Exec = (command: string, args: string[], input?: string) => Promise<string>;

export const realExec: Exec = (command, args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(command, args, { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
    if (input !== undefined) child.stdin?.end(input);
  });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const KEYSTROKE_V = 'tell application "System Events" to keystroke "v" using command down';
const KEYSTROKE_C = 'tell application "System Events" to keystroke "c" using command down';

export const osascript = (exec: Exec, script: string) => exec("osascript", ["-e", script]);

export async function frontmostApp(exec: Exec = realExec): Promise<string | undefined> {
  try {
    const name = await osascript(
      exec,
      'tell application "System Events" to get name of first application process whose frontmost is true',
    );
    return name.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Types into the focused app the way macOS dictation tools usually do: put the text on the clipboard and press
 * Cmd+V, then restore the previous clipboard. Needs the Accessibility permission for "System Events" keystrokes.
 * Only plain-text clipboards are preserved.
 */
export class MacInjector implements TextInjector {
  constructor(
    private readonly exec: Exec = realExec,
    private readonly settleMs = 120,
  ) {}

  private readClipboard = () => this.exec("pbpaste", []);
  private writeClipboard = (text: string) => this.exec("pbcopy", [], text);

  private async withClipboard<T>(work: () => Promise<T>): Promise<T> {
    const saved = await this.readClipboard().catch(() => "");
    try {
      return await work();
    } finally {
      await this.writeClipboard(saved).catch(() => undefined);
    }
  }

  async insert(text: string): Promise<void> {
    await this.withClipboard(async () => {
      await this.writeClipboard(text);
      await osascript(this.exec, KEYSTROKE_V);
      await sleep(this.settleMs); // let the target app read the clipboard before we restore it
    });
  }

  async getSelection(): Promise<string> {
    return this.withClipboard(async () => {
      const marker = `voiceos-${Date.now()}`;
      await this.writeClipboard(marker);
      await osascript(this.exec, KEYSTROKE_C);
      await sleep(this.settleMs);
      const copied = await this.readClipboard();
      return copied === marker ? "" : copied;
    });
  }

  replaceSelection(text: string): Promise<void> {
    return this.insert(text); // pasting over a selection replaces it
  }
}

const EXTRA_PATHS = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"];

/** GUI apps on macOS start with a bare PATH, so tools like `codex` and `whisper-cli` are not found. */
export async function resolveMacPath(currentPath: string, home: string, exec: Exec = realExec, shell = "/bin/zsh") {
  let shellPath = "";
  try {
    shellPath = (await exec(shell, ["-ilc", 'printf %s "$PATH"'])).trim();
  } catch {
    // fall back to the common install locations below
  }
  const parts = [...shellPath.split(":"), ...currentPath.split(":"), ...EXTRA_PATHS, `${home}/.npm-global/bin`];
  return [...new Set(parts.filter(Boolean))].join(":");
}
