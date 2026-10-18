import type { Clock } from "../core/types.js";
import { systemClock } from "../core/types.js";
import type { Change } from "./changes.js";

export const LEARNING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Stores observed corrections (inserted word → corrected word). */
export interface CorrectionStore {
  add(inserted: string, corrected: string, at: number): void;
  count(inserted: string, corrected: string, since: number): number;
  prune(before: number): void;
}

export class MemoryCorrectionStore implements CorrectionStore {
  private rows: Array<{ inserted: string; corrected: string; at: number }> = [];
  add(inserted: string, corrected: string, at: number): void {
    this.rows.push({ inserted, corrected, at });
  }
  count(inserted: string, corrected: string, since: number): number {
    return this.rows.filter((r) => r.inserted === inserted && r.corrected === corrected && r.at >= since).length;
  }
  prune(before: number): void {
    this.rows = this.rows.filter((r) => r.at >= before);
  }
}

export interface LearningSuggestion {
  written: string;
  spoken: string;
  change: Change;
}

/**
 * Turns repeated corrections into dictionary suggestions.
 * The same single-word correction twice within 7 days yields one suggestion, reported as `dictionary_added`.
 */
export class CorrectionLearner {
  enabled = true;

  constructor(
    private readonly store: CorrectionStore,
    private readonly isKnown: (written: string) => boolean = () => false,
    private readonly clock: Clock = systemClock,
  ) {}

  observe(inserted: string, corrected: string): LearningSuggestion | undefined {
    const from = inserted.trim();
    const to = corrected.trim();
    if (!this.enabled || !from || !to || from === to || /\s/.test(from) || /\s/.test(to)) return undefined;
    const now = this.clock.now();
    this.store.prune(now - LEARNING_WINDOW_MS);
    this.store.add(from.toLowerCase(), to, now);
    if (this.store.count(from.toLowerCase(), to, now - LEARNING_WINDOW_MS) !== 2) return undefined;
    if (this.isKnown(to)) return undefined;
    return {
      written: to,
      spoken: from.toLowerCase(),
      change: { category: "dictionary_added", before: from, after: to },
    };
  }
}
