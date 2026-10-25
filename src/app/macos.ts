import { execFile } from "node:child_process";
import type { InjectorCommand, TextInjector } from "../core/types.js";

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
const KEYSTROKE_A = 'tell application "System Events" to keystroke "a" using command down';
const KEYSTROKE_Z = 'tell application "System Events" to keystroke "z" using command down';

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
    private readonly accessibilitySelection = false,
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
    if (this.accessibilitySelection) {
      // Reading AXSelectedText avoids synthetic Cmd+C cancelling a held edit hotkey.
      return (await osascript(this.exec, `tell application "System Events"
        set p to first application process whose frontmost is true
        set field to value of attribute "AXFocusedUIElement" of p
        return value of attribute "AXSelectedText" of field
      end tell`)).replace(/\r?\n$/, "");
    }
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

  /** "Scratch that" and "select all" become the usual Cmd+Z / Cmd+A keystrokes in the focused app. */
  async command(name: InjectorCommand): Promise<void> {
    await osascript(this.exec, name === "undo" ? KEYSTROKE_Z : KEYSTROKE_A);
  }
}

export type SystemSound = "done" | "error";
const SOUND_FILES: Record<SystemSound, string> = { done: "Glass", error: "Basso" };

/** Plays a built-in macOS alert sound without waiting for it, so the notch never blocks on audio. */
export function playSystemSound(sound: SystemSound, exec: Exec = realExec): void {
  void exec("afplay", [`/System/Library/Sounds/${SOUND_FILES[sound]}.aiff`]).catch(() => undefined);
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

/** Capture focus and field contents so a delayed paste can fail closed after navigation or typing. */
export async function captureMacTarget(exec: Exec = realExec): Promise<string | undefined> {
  try {
    const snapshot = await osascript(exec, `tell application "System Events"
      set p to first application process whose frontmost is true
      set pid to unix id of p
      set w to front window of p
      set field to value of attribute "AXFocusedUIElement" of p
      set detail to (name of w as text) & "|" & (position of w as text) & "|" & (size of w as text)
      set detail to detail & "|" & (role of field as text) & "|" & (position of field as text) & "|" & (size of field as text)
      try
        set detail to detail & "|document:" & (value of attribute "AXDocument" of w as text)
      end try
      try
        set detail to detail & "|identifier:" & (value of attribute "AXIdentifier" of field as text)
      end try
      try
        set detail to detail & "|value:" & (value of attribute "AXValue" of field as text)
      end try
      try
        set detail to detail & "|range:" & (value of attribute "AXSelectedTextRange" of field as text)
      end try
      return (pid as text) & linefeed & detail
    end tell`);
    const newline = snapshot.indexOf("\n");
    const pid = Number(snapshot.slice(0, newline));
    if (newline < 1 || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
    return JSON.stringify({ pid, snapshot: snapshot.slice(newline + 1).trim() });
  } catch { return undefined; }
}

export async function restoreMacTarget(target: string, exec: Exec = realExec): Promise<void> {
  const { pid } = JSON.parse(target) as { pid: number };
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid destination.");
  await osascript(exec, `tell application "System Events" to set frontmost of first application process whose unix id is ${pid} to true`);
  await sleep(150);
}
