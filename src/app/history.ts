import { z } from "zod";
import type { VoiceResult } from "./session.js";

const Stored = z.array(z.object({
  id: z.string(), at: z.number(), mode: z.enum(["dictate", "edit", "agent"]), transcript: z.string(), text: z.string(),
  status: z.enum(["inserted", "ready", "failed", "cancelled", "completed"]), error: z.string().optional(),
}));

/** Reads saved results, dropping anything malformed rather than failing startup. */
export function parseStoredHistory(json: string): VoiceResult[] {
  try { return Stored.parse(JSON.parse(json)); } catch { return []; }
}

/** Memory-only, bounded history. With history off only the latest result is retained for recovery. */
export class ResultHistory {
  private entries: VoiceResult[] = [];
  constructor(private enabled = false, private limit = 20) {}
  configure(enabled: boolean, limit: number): void {
    this.enabled = enabled;
    this.limit = limit;
    this.entries = this.entries.slice(0, enabled ? limit : 1);
  }
  add(entry: VoiceResult): void {
    this.entries = [entry, ...this.entries.filter((item) => item.id !== entry.id)].slice(0, this.enabled ? this.limit : 1);
  }
  list(): VoiceResult[] { return this.entries.map((entry) => ({ ...entry })); }
  get(id: string): VoiceResult | undefined { return this.list().find((entry) => entry.id === id); }
  clear(): void { this.entries = []; }
  restore(entries: VoiceResult[]): void { this.entries = entries.slice(0, this.enabled ? this.limit : 1); }
}
