import type { Change } from "./changes.js";

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
const CARDINALS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

interface ListOptions {
  /** Capitalize each item. Off for code. */
  capitalize?: boolean;
}

/**
 * Turns spoken enumerations into lists:
 * "first … second …" or "one, … two, …" become a numbered list, "bullet … bullet …" a bulleted one.
 * Needs at least two non-empty items. Cardinals only count at the start of a clause, so "one dog and two cats" stays prose.
 */
export function formatLists(input: string, changes: Change[] = [], options: ListOptions = {}): string {
  const capitalize = options.capitalize ?? true;
  const attempts: Array<() => string | undefined> = [
    () => splitOn(input, sequenceMarkers(ORDINALS, false), "numbered", capitalize),
    () => splitOn(input, sequenceMarkers(CARDINALS, true), "numbered", capitalize),
    () => splitOn(input, bulletMarkers(), "bulleted", capitalize),
  ];
  for (const attempt of attempts) {
    const result = attempt();
    if (result !== undefined) {
      changes.push({ category: "list_formatted", before: input, after: result });
      return result;
    }
  }
  return input;
}

type MarkerFinder = (text: string) => Array<{ index: number; length: number }> | undefined;

function sequenceMarkers(words: string[], clauseStartOnly: boolean): MarkerFinder {
  return (text) => {
    const markers: Array<{ index: number; length: number }> = [];
    let from = 0;
    for (const word of words) {
      const lead = clauseStartOnly ? "(?:^|[.,;:!?]\\s*)" : "(?:^|[\\s.,;:!?])";
      const pattern = new RegExp(`${lead}(${word}(?:ly)?)\\b[,:]?\\s*`, "gi");
      pattern.lastIndex = from;
      const match = pattern.exec(text);
      if (!match) break;
      const start = match.index + match[0].indexOf(match[1] ?? "");
      markers.push({ index: start, length: match.index + match[0].length - start });
      from = match.index + match[0].length;
    }
    return markers.length >= 2 ? markers : undefined;
  };
}

function bulletMarkers(): MarkerFinder {
  return (text) => {
    const markers = [...text.matchAll(/(?:^|(?<=[\s.,;:!?]))bullet(?: point)?\b[,:]?\s*/gi)].map((m) => ({
      index: m.index,
      length: m[0].length,
    }));
    return markers.length >= 2 ? markers : undefined;
  };
}

function splitOn(
  text: string,
  find: MarkerFinder,
  style: "numbered" | "bulleted",
  capitalize: boolean,
): string | undefined {
  const markers = find(text);
  if (!markers) return undefined;
  const items: string[] = [];
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i]!;
    const end = markers[i + 1]?.index ?? text.length;
    const item = cleanItem(text.slice(marker.index + marker.length, end), capitalize);
    if (!item) return undefined;
    items.push(item);
  }
  const intro = text
    .slice(0, markers[0]!.index)
    .trim()
    .replace(/[\s,;:.]+$/u, "");
  const lines = items.map((item, i) => (style === "numbered" ? `${i + 1}. ${item}` : `- ${item}`));
  return intro ? `${intro}:\n${lines.join("\n")}` : lines.join("\n");
}

function cleanItem(raw: string, capitalize: boolean): string {
  let item = raw
    .trim()
    .replace(/^[,;:.\s]+/u, "")
    .replace(/(?:[,;\s]+(?:and|then|and then))?[,;.\s]*$/iu, "");
  if (capitalize) item = item.charAt(0).toUpperCase() + item.slice(1);
  return item;
}
