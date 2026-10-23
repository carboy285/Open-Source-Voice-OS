import type { InjectorCommand } from "../core/types.js";
import { FILLERS } from "./dictation.js";

/** What a spoken utterance means: normal dictation, a saved snippet, or a built-in editing command. */
export type Utterance =
  | { kind: "text"; text: string }
  | { kind: "snippet"; trigger: string; text: string }
  | { kind: "command"; command: InjectorCommand };

export interface UtteranceOptions {
  /** Saved snippets, keyed by the phrase the user says. */
  snippets?: Record<string, string>;
  /** Resolve built-in editing commands. Default true; turn off to dictate phrases like "select all" as text. */
  commands?: boolean;
}

const COMMANDS: Array<[InjectorCommand, string[]]> = [
  ["undo", ["scratch that", "undo that"]],
  ["selectAll", ["select all"]],
];

/**
 * Lowercases, drops filler words, collapses whitespace and strips surrounding punctuation, so
 * "Um, Scratch that." and "  scratch   that  " both match. Whisper likes to add a full stop to
 * every utterance.
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(FILLERS, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s.,!?;:'"“”‘’]+|[\s.,!?;:'"“”‘’]+$/g, "")
    .trim();
}

function matchSnippet(normalized: string, snippets: Record<string, string>): Utterance | undefined {
  for (const [trigger, text] of Object.entries(snippets)) {
    const key = normalize(trigger);
    if (key && key === normalized) return { kind: "snippet", trigger: trigger.trim(), text };
  }
  return undefined;
}

/**
 * Matches the whole utterance only, never a phrase inside a sentence: "select all" is a command,
 * but "select all the rows and delete them" is dictation. Commands win over snippets with the same
 * trigger. "insert my address" is accepted as a shorthand for the snippet "my address".
 */
export function resolveUtterance(transcript: string, options: UtteranceOptions = {}): Utterance {
  const normalized = normalize(transcript);
  if (!normalized) return { kind: "text", text: transcript };

  if (options.commands !== false) {
    for (const [command, phrases] of COMMANDS) {
      if (phrases.includes(normalized)) return { kind: "command", command };
    }
  }

  const snippets = options.snippets ?? {};
  const direct = matchSnippet(normalized, snippets);
  if (direct) return direct;

  const withoutInsert = normalized.replace(/^insert\s+/, "");
  if (withoutInsert !== normalized) {
    const shorthand = matchSnippet(withoutInsert, snippets);
    if (shorthand) return shorthand;
  }

  return { kind: "text", text: transcript };
}

/** Parses repeated `--snippet "trigger=text"` flags. */
export function parseSnippetFlags(entries: string[] | undefined): Record<string, string> {
  const snippets: Record<string, string> = {};
  for (const entry of entries ?? []) {
    const separator = entry.indexOf("=");
    if (separator <= 0) throw new Error(`--snippet expects "trigger=text", got "${entry}".`);
    const trigger = entry.slice(0, separator).trim();
    const text = entry.slice(separator + 1);
    if (!trigger || !text) throw new Error(`--snippet needs a non-empty trigger and text, got "${entry}".`);
    snippets[trigger] = text;
  }
  return snippets;
}
