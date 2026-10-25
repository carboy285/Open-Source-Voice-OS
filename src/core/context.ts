/** Guesses what kind of writing an app is for, so cleanup and rewrites can match its conventions. */
const KINDS: Array<[string, RegExp]> = [
  ["email", /\b(mail|outlook|superhuman|spark|gmail|airmail)\b/i],
  ["chat", /\b(messages|slack|discord|telegram|whatsapp|teams|signal|messenger)\b/i],
  ["code", /\b(xcode|code|cursor|terminal|iterm|warp|ghostty|intellij|pycharm|webstorm|zed|sublime|vim)\b/i],
  ["document", /\b(notes|pages|word|obsidian|notion|bear|ulysses|docs|textedit)\b/i],
];

export function appKind(appName: string | undefined): string | undefined {
  if (!appName) return undefined;
  return KINDS.find(([, pattern]) => pattern.test(appName))?.[0];
}

/** How much of the focused field is shared with the model: the end of the text, nearest the cursor. */
export const MAX_SCREEN_TEXT = 3000;
