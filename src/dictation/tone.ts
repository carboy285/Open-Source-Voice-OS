import type { AppContext } from "../core/types.js";
import type { Change } from "./changes.js";

export type AppCategory = "email" | "chat" | "notes" | "document" | "code" | "general";
export const APP_CATEGORIES: AppCategory[] = ["email", "chat", "notes", "document", "code", "general"];

/** Built-in app table: bundle ids (macOS) and executable names (Windows), lower-case. */
export const APP_TABLE: Record<string, AppCategory> = {
  "com.apple.mail": "email",
  "com.microsoft.outlook": "email",
  "outlook.exe": "email",
  "olk.exe": "email",
  "thunderbird.exe": "email",
  "org.mozilla.thunderbird": "email",
  "com.readdle.smartemail-mac": "email",
  "com.tinyspeck.slackmacgap": "chat",
  "slack.exe": "chat",
  "com.microsoft.teams2": "chat",
  "com.microsoft.teams": "chat",
  "ms-teams.exe": "chat",
  "teams.exe": "chat",
  "com.hnc.discord": "chat",
  "discord.exe": "chat",
  "com.apple.mobilesms": "chat",
  "net.whatsapp.whatsapp": "chat",
  "whatsapp.exe": "chat",
  "jp.naver.line.mac": "chat",
  "line.exe": "chat",
  "ru.keepcoder.telegram": "chat",
  "telegram.exe": "chat",
  "com.apple.notes": "notes",
  "md.obsidian": "notes",
  "obsidian.exe": "notes",
  "notion.id": "notes",
  "notion.exe": "notes",
  "com.microsoft.onenote.mac": "notes",
  "onenote.exe": "notes",
  "com.microsoft.word": "document",
  "winword.exe": "document",
  "com.apple.iwork.pages": "document",
  "com.microsoft.vscode": "code",
  "code.exe": "code",
  "com.todesktop.230313mzl4w4u92": "code",
  "cursor.exe": "code",
  "com.apple.dt.xcode": "code",
  "com.apple.terminal": "code",
  "com.googlecode.iterm2": "code",
  "dev.warp.warp-stable": "code",
  "windowsterminal.exe": "code",
  "cmd.exe": "code",
  "powershell.exe": "code",
  "pwsh.exe": "code",
  "devenv.exe": "code",
};

const JETBRAINS = /^com\.jetbrains\.|^(idea|pycharm|webstorm|goland|rider|clion|phpstorm|rubymine)(64)?\.exe$/;

const BROWSERS = new Set([
  "com.apple.safari",
  "com.google.chrome",
  "org.mozilla.firefox",
  "com.microsoft.edgemac",
  "com.brave.browser",
  "company.thebrowser.browser",
  "chrome.exe",
  "msedge.exe",
  "firefox.exe",
  "brave.exe",
  "opera.exe",
]);

/** Window-title keywords for browser tabs, checked in order. */
const TITLE_KEYWORDS: Array<[RegExp, AppCategory]> = [
  [/\b(gmail|outlook\.(live|office)|mail\.yahoo|proton ?mail|fastmail|inbox)\b/i, "email"],
  [/\b(slack|discord|microsoft teams|whatsapp|messenger|telegram|line)\b/i, "chat"],
  [/\b(notion|obsidian|onenote|keep|evernote)\b/i, "notes"],
  [/\b(google docs|docs\.google|word online|dropbox paper)\b/i, "document"],
  [/\b(github|gitlab|codepen|stackblitz|codesandbox|replit)\b/i, "code"],
];

/** Maps the shell's app report to a category. User overrides win, then the id table, then title keywords. */
export function categorize(ctx: AppContext, overrides: Record<string, AppCategory> = {}): AppCategory {
  if (ctx.kind && (APP_CATEGORIES as string[]).includes(ctx.kind)) return ctx.kind as AppCategory;
  const id = (ctx.appId ?? ctx.appName ?? "").toLowerCase();
  const override = overrides[id];
  if (override) return override;
  const known = APP_TABLE[id];
  if (known) return known;
  if (JETBRAINS.test(id)) return "code";
  const title = ctx.windowTitle ?? "";
  if (BROWSERS.has(id) || !id) {
    for (const [pattern, category] of TITLE_KEYWORDS) if (pattern.test(title)) return category;
  }
  return "general";
}

/** Style rules handed to model polish, per category. */
export const STYLE_RULES: Record<AppCategory, string> = {
  email:
    "Write full sentences. Keep a greeting or sign-off only if the speaker said one. Start a new paragraph when the topic changes.",
  chat: "Keep it casual and short. Leave emoji words as spoken. No period at the end of a one-sentence message.",
  notes: "Lists are welcome and terse fragments are fine.",
  document: "Use formal punctuation and paragraphs.",
  code: "Do not change anything.",
  general: "Use a neutral style.",
};

/** Pipeline switches that depend on the category. */
export interface ToneBehavior {
  polish: boolean;
  capitalize: boolean;
  finalPunctuation: boolean;
  spokenPunctuation: boolean;
}

export function toneBehavior(category: AppCategory, enabled = true): ToneBehavior {
  if (category === "code" && enabled) {
    return { polish: false, capitalize: false, finalPunctuation: false, spokenPunctuation: false };
  }
  return { polish: true, capitalize: true, finalPunctuation: true, spokenPunctuation: true };
}

/** Rule-based part of the tone pass. Model polish handles the rest. */
export function applyToneRules(text: string, category: AppCategory, changes: Change[] = []): string {
  if (category === "chat" && !text.includes("\n")) {
    const sentences = text.match(/[^.!?。]+[.!?。]+/g) ?? [text];
    if (sentences.length <= 1 && /[^.]\.$/.test(text) && !/\.\.\.$/.test(text)) {
      const after = text.slice(0, -1);
      changes.push({ category: "formatting", before: text, after });
      return after;
    }
  }
  return text;
}
