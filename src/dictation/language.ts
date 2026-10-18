/** Coarse language/script detection, enough to catch a translated polish result. */
export type Script = "ja" | "zh" | "ko" | "cyrillic" | "arabic" | "latin" | "other" | "none";

const PATTERNS: Array<[Exclude<Script, "none" | "other">, RegExp]> = [
  ["ja", /[぀-ヿ]/gu],
  ["zh", /[一-鿿]/gu],
  ["ko", /[가-힯]/gu],
  ["cyrillic", /[Ѐ-ӿ]/gu],
  ["arabic", /[؀-ۿ]/gu],
  ["latin", /[A-Za-zÀ-ɏ]/gu],
];

export function detectScript(text: string): Script {
  const counts = new Map<Script, number>();
  for (const [script, pattern] of PATTERNS) counts.set(script, text.match(pattern)?.length ?? 0);
  // Kanji alongside any kana means Japanese.
  if ((counts.get("ja") ?? 0) > 0) counts.set("ja", (counts.get("ja") ?? 0) + (counts.get("zh") ?? 0));
  let best: Script = "none";
  let max = 0;
  for (const [script, count] of counts) {
    if (count > max) {
      best = script;
      max = count;
    }
  }
  return best;
}

const EN_COMMON = new Set(
  "the a an and or but to of in on at for with is are was were be it this that i you we they he she not do have will can my your our".split(
    " ",
  ),
);

/** Share of very common English words; used to notice an English text turned into another Latin-script language. */
export function englishRatio(text: string): number {
  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  if (words.length === 0) return 0;
  return words.filter((w) => EN_COMMON.has(w)).length / words.length;
}

/** True when `after` is likely in a different language than `before`. */
export function languageChanged(before: string, after: string): boolean {
  const a = detectScript(before);
  const b = detectScript(after);
  if (a === "none" || b === "none") return false;
  if (a !== b) return true;
  if (a === "latin" && before.split(/\s+/).length >= 6) {
    return englishRatio(before) >= 0.2 && englishRatio(after) < 0.05;
  }
  return false;
}

export function isCjk(text: string): boolean {
  const script = detectScript(text);
  return script === "ja" || script === "zh";
}
