import type { AppContext, LlmProvider, TextInjector } from "../core/types.js";
import type { CleanResult } from "../dictation/changes.js";
import { cleanup, type CleanupOptions } from "../dictation/cleanup.js";
import { applyDictionary } from "../dictation/dictionary.js";
import { polish } from "../dictation/polish.js";
import { categorize, type AppCategory } from "../dictation/tone.js";

export { cleanTranscript, cleanup } from "../dictation/cleanup.js";

export interface DictationOptions extends Omit<CleanupOptions, "category"> {
  /** When set, the rule-based result is refined by a model that knows the target app. */
  polish?: LlmProvider;
  mode?: "verbatim" | "clean" | "polished";
  polishTimeoutMs?: number;
  writingInstructions?: string;
  /** User overrides for the app → category table. */
  categoryOverrides?: Record<string, AppCategory>;
  /** Categories where the user turned tone adaptation off. */
  toneDisabled?: AppCategory[];
}

export interface DictationResult extends CleanResult {
  category: AppCategory;
  appliedIds: number[];
}

/** Cleans a transcript for the given app, without inserting it. */
export async function processDictation(
  transcript: string,
  context: AppContext = {},
  options: DictationOptions = {},
): Promise<DictationResult> {
  const category = categorize(context, options.categoryOverrides);
  if (options.mode === "verbatim") {
    const result = applyDictionary(transcript, options.dictionary ?? []);
    return { ...result, category, changes: [] };
  }
  const toneEnabled = !options.toneDisabled?.includes(category);
  const rules = cleanup(transcript, { ...options, category, toneEnabled });
  if (!rules.text || options.mode === "clean" || !options.polish || (category === "code" && toneEnabled))
    return { ...rules, category };
  const polished = await polish(rules.text, options.polish, {
    category: toneEnabled ? category : "general",
    preserve: options.dictionary?.map((e) => e.written),
    timeoutMs: options.polishTimeoutMs,
    appName: context.appName,
    writingInstructions: options.writingInstructions,
  });
  return {
    text: polished.text,
    changes: [...rules.changes, ...polished.changes],
    appliedIds: rules.appliedIds,
    category,
  };
}

/** Cleans a transcript and inserts it. An empty result inserts nothing. */
export async function dictate(
  transcript: string,
  injector: TextInjector,
  context: AppContext = {},
  options: DictationOptions = {},
): Promise<DictationResult> {
  const result = await processDictation(transcript, context, options);
  if (result.text) await injector.insert(result.text);
  return result;
}
