/** Change-report categories (dictation.md). */
export type ChangeCategory =
  | "filler_removed"
  | "punctuation"
  | "dictionary_applied"
  | "formatting"
  | "list_formatted"
  | "spelling_fixed"
  | "grammar_fixed"
  | "dictionary_added"
  | "polish_rejected";

export interface Change {
  category: ChangeCategory;
  before: string;
  after: string;
}

export interface CleanResult {
  text: string;
  changes: Change[];
}

/** Counts per category, for the one-line report ("Removed 3 fillers · Fixed 1 spelling"). */
export function summarizeChanges(changes: Change[]): Partial<Record<ChangeCategory, number>> {
  const counts: Partial<Record<ChangeCategory, number>> = {};
  for (const change of changes) counts[change.category] = (counts[change.category] ?? 0) + 1;
  return counts;
}
