import { z } from "zod";

/** Heard phrase -> preferred spelling. Aliases are case-insensitive, literal whole phrases. */
export const Vocabulary = z.record(z.string().trim().min(1), z.string().trim().min(1)).superRefine((entries, ctx) => {
  const seen = new Set<string>();
  for (const alias of Object.keys(entries)) {
    const key = alias.toLowerCase();
    if (seen.has(key)) ctx.addIssue({ code: "custom", message: `Duplicate vocabulary alias: ${alias}` });
    seen.add(key);
  }
});
export type Vocabulary = z.infer<typeof Vocabulary>;

/** One pass, longest phrase first; replacements are literal and never trigger other replacements. */
export function applyVocabulary(text: string, vocabulary: Vocabulary = {}): string {
  const entries = Object.entries(vocabulary).filter(([alias]) => alias.trim().length > 0);
  if (entries.length === 0) return text;
  entries.sort(([a], [b]) => b.length - a.length);
  const alternatives = entries.map(([alias], index) =>
    `(?<v${index}>${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
  ).join("|");
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternatives})(?![\\p{L}\\p{N}_])`, "giu");
  return text.replace(pattern, (phrase, ...args) => {
    const groups = args.at(-1) as Record<string, string | undefined>;
    const matched = Object.keys(groups).find((name) => groups[name] !== undefined);
    return matched === undefined ? phrase : entries[Number(matched.slice(1))]![1];
  });
}
