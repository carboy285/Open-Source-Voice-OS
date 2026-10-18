import type { Change } from "./changes.js";

/** English hesitation words, removed anywhere as whole words. */
const EN_FILLER = /(^|[\s,])(um+|uh+|uhm+|erm?|hmm+|mm+)\b[,.]?(?=\s|$)/gi;
/** Discourse fillers that are only fillers when set off by a comma. */
const EN_PHRASE = /(^|[\s,])(you know|i mean)(,\s*|(?=[.!?]))/gi;
const REPEAT = /(?<![\p{L}'])([\p{L}']+)(?:\s+\1(?![\p{L}']))+/giu;
/** Repeats that are valid English. */
const VALID_REPEATS = new Set(["had", "that", "very", "really", "bye", "no", "so"]);

/** Japanese hesitation sounds. あの/その only count when followed by a pause or a long vowel. */
const JA_FILLER =
  /(^|[、。！？\s])(えーっと|えっと|ええと|えーと|えー+|あのー*(?=[、\s])|あのー+|そのー+|うーん|うーむ|まあ(?=[、\s])|なんか(?=[、\s]))[、\s]*/gu;

export function removeFillers(input: string, changes: Change[]): string {
  let text = input.replace(EN_FILLER, (_m, lead: string, word: string) => {
    changes.push({ category: "filler_removed", before: word, after: "" });
    return lead;
  });
  text = text.replace(EN_PHRASE, (_m, lead: string, phrase: string) => {
    changes.push({ category: "filler_removed", before: phrase, after: "" });
    return lead;
  });
  text = text.replace(JA_FILLER, (_m, lead: string, word: string) => {
    changes.push({ category: "filler_removed", before: word, after: "" });
    return lead;
  });
  text = text.replace(REPEAT, (match: string, word: string) => {
    if (VALID_REPEATS.has(word.toLowerCase())) return match;
    changes.push({ category: "filler_removed", before: match, after: word });
    return word;
  });
  return text;
}
