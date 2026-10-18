import type { Change } from "./changes.js";

export type EntryKind = "name" | "product" | "acronym" | "term";

export interface DictionaryEntry {
  id: number;
  /** Canonical spelling, inserted exactly. */
  written: string;
  /** Variants the STT tends to produce. */
  spoken: string[];
  kind: EntryKind;
  /** When true, `written` itself only matches in its exact case. Spoken variants always match case-insensitively. */
  caseSensitive: boolean;
  source: "manual" | "learned";
  uses: number;
  createdAt: number;
  updatedAt: number;
}

export interface DictionaryResult {
  text: string;
  /** Ids of the entries that changed the text, once per replacement. */
  appliedIds: number[];
}

const URL =
  /\b(?:https?:\/\/|www\.)[^\s<>"']+|\b[\w-]+(?:\.[\w-]+)*\.(?:com|org|net|io|dev|app|ai|co|jp|edu|gov)(?:\/[^\s<>"']*)?/giu;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu;
const CODE = /`[^`]*`/gu;

/** Character ranges where entries are never applied: URLs, email addresses and backtick code spans. */
export function protectedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const pattern of [CODE, EMAIL, URL]) {
    for (const match of text.matchAll(pattern)) ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasCjk = (s: string) => /[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/u.test(s);

interface Variant {
  text: string;
  entry: DictionaryEntry;
  exactCase: boolean;
}

/**
 * Picks one entry per spoken form. Conflicts go to the most recently updated entry.
 * Returns the conflicting forms so Settings can warn about them.
 */
export function buildVariants(entries: DictionaryEntry[]): { variants: Variant[]; conflicts: string[] } {
  const byKey = new Map<string, Variant>();
  const conflicts = new Set<string>();
  for (const entry of entries) {
    const forms: Array<[string, boolean]> = [
      [entry.written, entry.caseSensitive],
      ...entry.spoken.map((s): [string, boolean] => [s, false]),
    ];
    for (const [form, exactCase] of forms) {
      const trimmed = form.trim().replace(/\s+/g, " ");
      if (!trimmed) continue;
      const key = exactCase ? `=${trimmed}` : trimmed.toLowerCase();
      const existing = byKey.get(key);
      if (existing && existing.entry.id !== entry.id) {
        conflicts.add(trimmed.toLowerCase());
        if (existing.entry.updatedAt >= entry.updatedAt) continue;
      }
      byKey.set(key, { text: trimmed, entry, exactCase });
    }
  }
  return { variants: [...byKey.values()], conflicts: [...conflicts] };
}

/** Whole-word, longest-match substitution of dictionary entries. */
export function applyDictionary(text: string, entries: DictionaryEntry[], changes: Change[] = []): DictionaryResult {
  const { variants } = buildVariants(entries);
  if (variants.length === 0 || !text) return { text, appliedIds: [] };
  variants.sort((a, b) => b.text.length - a.text.length);

  const sources = variants.map((v, i) => {
    const body = v.text.split(" ").map(escapeRegExp).join("\\s+");
    const bounded = hasCjk(v.text) ? body : `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`;
    return `(?<v${i}>${bounded})`;
  });
  const pattern = new RegExp(sources.join("|"), "giu");
  const ranges = protectedRanges(text);
  const appliedIds: number[] = [];

  const out = text.replace(pattern, (...args: unknown[]) => {
    const match = args[0] as string;
    const offset = args[args.length - 3] as number;
    const groups = args[args.length - 1] as Record<string, string | undefined>;
    if (ranges.some(([start, end]) => offset < end && offset + match.length > start)) return match;
    const index = Object.keys(groups).findIndex((key) => groups[key] !== undefined);
    const variant = index >= 0 ? variants[Number(Object.keys(groups)[index]?.slice(1))] : undefined;
    if (!variant || match === variant.entry.written) return match;
    if (variant.exactCase && match !== variant.text) return match;
    appliedIds.push(variant.entry.id);
    changes.push({ category: "dictionary_applied", before: match, after: variant.entry.written });
    return variant.entry.written;
  });
  return { text: out, appliedIds };
}

/** Vocabulary hint for the STT provider: most-used entries first, about `maxTokens` tokens. */
export function vocabularyHint(entries: DictionaryEntry[], maxTokens = 200): string {
  const words: string[] = [];
  let tokens = 0;
  for (const entry of [...entries].sort((a, b) => b.uses - a.uses)) {
    const cost = Math.ceil(entry.written.length / 4) + 1;
    if (tokens + cost > maxTokens) break;
    words.push(entry.written);
    tokens += cost;
  }
  return words.join(", ");
}
