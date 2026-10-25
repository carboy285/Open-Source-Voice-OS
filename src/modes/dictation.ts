import type { AppContext, LlmProvider, TextInjector } from "../core/types.js";

export const FILLERS = /\b(?:um+|uh+|erm?|hmm+|you know|i mean)\b[,.]?\s*/gi;

const SPOKEN_PUNCTUATION: Array<[RegExp, string]> = [
  [/\s*\bnew paragraph\b[,.]?\s*/gi, "\n\n"],
  [/\s*\bnew line\b[,.]?\s*/gi, "\n"],
  [/\s*\bquestion mark\b/gi, "?"],
  [/\s*\bexclamation (?:point|mark)\b/gi, "!"],
  [/\s*\bcomma\b/gi, ","],
  [/\s*\bperiod\b/gi, "."],
  [/\s*\bfull stop\b/gi, "."],
];

export interface CleanupOptions {
  /** Convert spoken "comma", "period", "new line" into symbols. Off by default: they are also normal words. */
  spokenPunctuation?: boolean;
}

/** Deterministic cleanup that needs no model: fillers, stutters, casing, sentence punctuation. */
export function cleanTranscript(raw: string, options: CleanupOptions = {}): string {
  let text = raw.replace(FILLERS, "");
  if (options.spokenPunctuation) {
    for (const [pattern, replacement] of SPOKEN_PUNCTUATION) text = text.replace(pattern, replacement);
  }
  // "the the cat" -> "the cat"
  text = text.replace(/\b(\w+)(?:\s+\1\b)+/gi, "$1");
  text = text.replace(/[ \t]+/g, " ").replace(/ +([,.!?;:])/g, "$1").replace(/ *\n */g, "\n").trim();
  if (!text) return "";
  text = text.replace(/(^|[.!?]\s+|\n)([a-z])/g, (_, lead: string, ch: string) => lead + ch.toUpperCase());
  if (!/[.!?]$/.test(text) && !text.includes("\n")) text += ".";
  return text;
}

const POLISH_SYSTEM = `You clean up dictated speech. Fix grammar and punctuation, remove disfluencies, and keep the speaker's meaning, wording and language. Match the formatting conventions of the app described by the user. Reply with the cleaned text only: no quotes, no commentary.`;

export interface DictationOptions extends CleanupOptions {
  mode?: "verbatim" | "clean" | "polished";
  vocabulary?: Record<string, string>;
  /** When set, the rule-based result is refined by a model that knows the target app. */
  polish?: LlmProvider;
}

export async function dictate(
  transcript: string,
  injector: TextInjector,
  context: AppContext = {},
  options: DictationOptions = {},
): Promise<string> {
  let text = options.mode === "verbatim" ? transcript : cleanTranscript(transcript, options);
  // Match all aliases against the original text in one pass, avoiding replacement cascades.
  const aliases = Object.keys(options.vocabulary ?? {}).filter(Boolean).sort((a, b) => b.length - a.length);
  if (aliases.length) {
    const escaped = aliases.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const entries = new Map(aliases.map((key) => [key.toLowerCase(), options.vocabulary![key]!]));
    text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}_])(?:${escaped.join("|")})(?![\\p{L}\\p{N}_])`, "giu"),
      (match) => entries.get(match.toLowerCase()) ?? match);
  }
  if (!text) return "";
  if (options.polish && options.mode !== "verbatim" && options.mode !== "clean") {
    const where = context.appName ? `The text goes into ${context.appName}${context.kind ? ` (${context.kind})` : ""}.` : "";
    const response = await options.polish.complete({
      system: POLISH_SYSTEM,
      messages: [{ role: "user", text: `${where}${context.screenText ? `\n\nText already in the field, for context only. Do not repeat it:\n${context.screenText}` : ""}\n\nDictation:\n${text}`.trim() }],
      maxTokens: 1024,
    });
    text = response.text.trim() || text;
  }
  await injector.insert(text);
  return text;
}
