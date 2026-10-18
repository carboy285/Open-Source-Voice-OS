import type { Change, CleanResult } from "./changes.js";
import { applyDictionary, type DictionaryEntry } from "./dictionary.js";
import { removeFillers } from "./fillers.js";
import { isCjk } from "./language.js";
import { formatLists } from "./lists.js";
import { applyToneRules, toneBehavior, type AppCategory } from "./tone.js";

export interface CleanupOptions {
  /** Convert spoken "comma", "period", "new line" into symbols. Off by default: they are also normal words. */
  spokenPunctuation?: boolean;
  dictionary?: DictionaryEntry[];
  category?: AppCategory;
  /** Tone adaptation for this category. Default true. */
  toneEnabled?: boolean;
  /** Language code reported by STT, e.g. "ja". */
  language?: string;
}

export interface CleanupResult extends CleanResult {
  /** Dictionary entries applied, for usage counts. */
  appliedIds: number[];
}

const SPOKEN_PUNCTUATION: Array<[RegExp, string]> = [
  [/\s*\bnew paragraph\b[,.]?\s*/gi, "\n\n"],
  [/\s*\bnew line\b[,.]?\s*/gi, "\n"],
  [/\s*\bquestion mark\b/gi, "?"],
  [/\s*\bexclamation (?:point|mark)\b/gi, "!"],
  [/\s*\bcomma\b/gi, ","],
  [/\s*\bperiod\b/gi, "."],
  [/\s*\bfull stop\b/gi, "."],
];

const JA_END = /[。！？!?」』）)…]$/u;

/** Rule stages 1–5 of the cleanup pipeline (no model). Each stage reports what it changed. */
export function cleanup(raw: string, options: CleanupOptions = {}): CleanupResult {
  const changes: Change[] = [];
  const category = options.category ?? "general";
  const behavior = toneBehavior(category, options.toneEnabled ?? true);
  const japanese = options.language === "ja" || isCjk(raw);

  let text = removeFillers(raw, changes);

  if (options.spokenPunctuation && behavior.spokenPunctuation) {
    for (const [pattern, replacement] of SPOKEN_PUNCTUATION) {
      text = text.replace(pattern, (match) => {
        changes.push({ category: "punctuation", before: match.trim(), after: replacement });
        return replacement;
      });
    }
  }

  text = tidySpacing(text, japanese);
  if (!text) return { text: "", changes, appliedIds: [] };

  const { text: substituted, appliedIds } = applyDictionary(text, options.dictionary ?? [], changes);
  text = substituted;

  text = formatSentences(text, japanese, behavior, changes);
  text = formatLists(text, changes, { capitalize: behavior.capitalize && !japanese });
  if (options.toneEnabled ?? true) text = applyToneRules(text, category, changes);
  return { text, changes, appliedIds };
}

/** Compatibility wrapper that returns only the text. */
export function cleanTranscript(raw: string, options: CleanupOptions = {}): string {
  return cleanup(raw, options).text;
}

function tidySpacing(text: string, japanese: boolean): string {
  let out = text
    .replace(/[ \t]+/g, " ")
    .replace(/ +([,.!?;:])/g, "$1")
    .replace(/ *\n */g, "\n")
    .replace(/^[\s,、]+/u, "")
    .replace(/,(\s*[,.!?])/g, "$1")
    .trim();
  if (japanese) out = out.replace(/(?<=[\u3000-\u30ff\u4e00-\u9fff]) +(?=[\u3000-\u30ff\u4e00-\u9fff])/gu, "");
  return out;
}

function formatSentences(
  text: string,
  japanese: boolean,
  behavior: { capitalize: boolean; finalPunctuation: boolean },
  changes: Change[],
): string {
  let out = text;
  if (japanese) {
    if (behavior.finalPunctuation && !JA_END.test(out) && !out.includes("\n")) {
      out = `${out.replace(/[.,、]$/u, "")}。`;
      changes.push({ category: "formatting", before: text, after: out });
    }
    return out;
  }
  if (behavior.capitalize) {
    const capitalized = out.replace(
      /(^|[.!?]\s+|\n)(\p{Ll})/gu,
      (_m, lead: string, ch: string) => lead + ch.toUpperCase(),
    );
    if (capitalized !== out) changes.push({ category: "formatting", before: out, after: capitalized });
    out = capitalized;
  }
  if (behavior.finalPunctuation && !/[.!?…:;]$/.test(out) && !out.includes("\n")) {
    changes.push({ category: "formatting", before: out, after: `${out}.` });
    out += ".";
  }
  return out;
}
