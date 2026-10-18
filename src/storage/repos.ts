import type { DictionaryEntry, EntryKind } from "../dictation/dictionary.js";
import type { CorrectionStore } from "../dictation/learning.js";
import type { StepRecord } from "../modes/agent.js";
import type { NewReminder, Reminder, ReminderStore, Repeat } from "../reminders/scheduler.js";
import { matches, type TaskRecord, type TaskStatus, type TaskStore } from "../tasks/types.js";
import type { Database } from "./db.js";

const DAY = 24 * 60 * 60 * 1000;

/** Defaults for every setting the core reads. Shells may store extra keys. */
export const DEFAULT_SETTINGS = {
  "history.saveTranscripts": false,
  "history.retentionDays": 30,
  "tasks.retentionDays": 30,
  "dictation.toggleMode": false,
  "dictation.spokenPunctuation": false,
  "dictation.learning": true,
  "dictation.languages": [] as string[],
  "tone.disabled": [] as string[],
  "tone.overrides": {} as Record<string, string>,
  "agent.maxSteps": 12,
  "agent.maxWallMs": 5 * 60 * 1000,
  "approval.timeoutMs": 10 * 60 * 1000,
  "mcp.callTimeoutMs": 60_000,
  "connectors.enabled": ["reminders", "files", "write"] as string[],
  "connectors.settings": {} as Record<string, Record<string, unknown>>,
  /** Circle to Ask: hold the circle key and drag around something on the screen. */
  "circle.enabled": true,
  /** Send a picture of the window with every Ask, not only when the typing box asks for it. */
  "screen.attach": false,
  "tts.enabled": true,
  /** Voice identifier from the shell; empty picks a voice that matches the reply's language. */
  "tts.voice": "",
  /** 0 to 1; the shell maps it to its own speech rate. */
  "tts.rate": 0.5,
  "composio.userId": "",
  "composio.apps": {} as Record<string, { enabled: boolean; readOnly: boolean }>,
  "llm.provider": "none" as "none" | "anthropic" | "openai-compatible" | "chatgpt",
  "llm.model": "",
  "llm.baseUrl": "",
  /** The OpenAI-compatible model can see images (circle to ask, screen questions). */
  "llm.vision": false,
  "stt.engine": "parakeet" as "parakeet" | "whisper",
  "stt.parakeetModel": "",
  "stt.parakeetBinary": "parakeet-cli",
  "stt.binary": "whisper-cli",
  "stt.model": "",
  "ui.locale": "system",
  "sound.enabled": true,
  "diagnostics.enabled": false,
  "diagnostics.endpoint": "",
  "secrets.index": [] as string[],
};

export type SettingKey = keyof typeof DEFAULT_SETTINGS;
export type Settings = typeof DEFAULT_SETTINGS;

export class SettingsRepo {
  constructor(private readonly db: Database) {}

  get<K extends SettingKey>(key: K): Settings[K];
  get(key: string): unknown;
  get(key: string): unknown {
    const row = this.db.sql.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      { value: string } | undefined;
    if (row) return JSON.parse(row.value);
    return structuredClone((DEFAULT_SETTINGS as Record<string, unknown>)[key]);
  }

  set(key: string, value: unknown): void {
    this.db.sql
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value));
  }

  all(): Record<string, unknown> {
    const rows = this.db.sql.prepare("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>;
    const out: Record<string, unknown> = structuredClone(DEFAULT_SETTINGS);
    for (const row of rows) out[row.key] = JSON.parse(row.value);
    return out;
  }
}

interface DictionaryRow {
  id: number;
  written: string;
  spoken: string;
  kind: string;
  case_sensitive: number;
  source: string;
  uses: number;
  created_at: number;
  updated_at: number;
}

const toEntry = (row: DictionaryRow): DictionaryEntry => ({
  id: row.id,
  written: row.written,
  spoken: JSON.parse(row.spoken) as string[],
  kind: row.kind as EntryKind,
  caseSensitive: row.case_sensitive === 1,
  source: row.source as DictionaryEntry["source"],
  uses: row.uses,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export type NewEntry = Pick<DictionaryEntry, "written"> & Partial<Omit<DictionaryEntry, "id" | "written">>;

export class DictionaryRepo {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  list(): DictionaryEntry[] {
    return (
      this.db.sql.prepare("SELECT * FROM dictionary ORDER BY uses DESC, written").all() as unknown as DictionaryRow[]
    ).map(toEntry);
  }

  get(id: number): DictionaryEntry | undefined {
    const row = this.db.sql.prepare("SELECT * FROM dictionary WHERE id = ?").get(id) as DictionaryRow | undefined;
    return row ? toEntry(row) : undefined;
  }

  findByWritten(written: string): DictionaryEntry | undefined {
    const row = this.db.sql.prepare("SELECT * FROM dictionary WHERE lower(written) = lower(?)").get(written) as
      DictionaryRow | undefined;
    return row ? toEntry(row) : undefined;
  }

  /** Adds an entry, or merges spoken variants into an existing one with the same written form. */
  add(entry: NewEntry): DictionaryEntry {
    const now = this.now();
    const existing = this.findByWritten(entry.written);
    if (existing) {
      const spoken = [...new Set([...existing.spoken, ...(entry.spoken ?? [])])];
      return this.update(existing.id, { spoken });
    }
    const kind = entry.kind ?? "term";
    const result = this.db.sql
      .prepare(
        "INSERT INTO dictionary (written, spoken, kind, case_sensitive, source, uses, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
      )
      .run(
        entry.written,
        JSON.stringify(entry.spoken ?? []),
        kind,
        (entry.caseSensitive ?? kind === "acronym") ? 1 : 0,
        entry.source ?? "manual",
        now,
        now,
      );
    return this.get(Number(result.lastInsertRowid))!;
  }

  update(id: number, patch: Partial<Omit<DictionaryEntry, "id" | "createdAt">>): DictionaryEntry {
    const current = this.get(id);
    if (!current) throw new Error(`No dictionary entry ${id}`);
    const next = { ...current, ...patch, updatedAt: this.now() };
    this.db.sql
      .prepare(
        "UPDATE dictionary SET written = ?, spoken = ?, kind = ?, case_sensitive = ?, source = ?, uses = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        next.written,
        JSON.stringify(next.spoken),
        next.kind,
        next.caseSensitive ? 1 : 0,
        next.source,
        next.uses,
        next.updatedAt,
        id,
      );
    return this.get(id)!;
  }

  remove(id: number): void {
    this.db.sql.prepare("DELETE FROM dictionary WHERE id = ?").run(id);
  }

  recordUses(ids: number[]): void {
    const stmt = this.db.sql.prepare("UPDATE dictionary SET uses = uses + 1 WHERE id = ?");
    for (const id of ids) stmt.run(id);
  }
}

export class CorrectionRepo implements CorrectionStore {
  constructor(private readonly db: Database) {}
  add(inserted: string, corrected: string, at: number): void {
    this.db.sql
      .prepare("INSERT INTO corrections (inserted, corrected, seen_at) VALUES (?, ?, ?)")
      .run(inserted, corrected, at);
  }
  count(inserted: string, corrected: string, since: number): number {
    const row = this.db.sql
      .prepare("SELECT count(*) AS n FROM corrections WHERE inserted = ? AND corrected = ? AND seen_at >= ?")
      .get(inserted, corrected, since) as { n: number };
    return row.n;
  }
  prune(before: number): void {
    this.db.sql.prepare("DELETE FROM corrections WHERE seen_at < ?").run(before);
  }
}

export interface DictationRecord {
  id: number;
  createdAt: number;
  category: string;
  wordCount: number;
  durationMs: number;
  transcript: string | null;
}

/** Dictation history. Transcript text is stored only when history.saveTranscripts is true. */
export class DictationHistoryRepo {
  constructor(
    private readonly db: Database,
    private readonly settings: SettingsRepo,
    private readonly now: () => number = Date.now,
  ) {}

  record(entry: { category: string; text: string; durationMs: number }): number {
    const keep = this.settings.get("history.saveTranscripts") === true;
    const words = entry.text.trim() ? entry.text.trim().split(/\s+/).length : 0;
    const result = this.db.sql
      .prepare(
        "INSERT INTO dictation_history (created_at, category, word_count, duration_ms, transcript) VALUES (?, ?, ?, ?, ?)",
      )
      .run(this.now(), entry.category, words, Math.round(entry.durationMs), keep ? entry.text : null);
    return Number(result.lastInsertRowid);
  }

  list(limit = 50): DictationRecord[] {
    const rows = this.db.sql
      .prepare(
        "SELECT id, created_at AS createdAt, category, word_count AS wordCount, duration_ms AS durationMs, transcript FROM dictation_history ORDER BY id DESC LIMIT ?",
      )
      .all(limit);
    return rows as unknown as DictationRecord[];
  }

  /** Removes stored text, keeping the counts. Offered when the user turns saveTranscripts off. */
  clearTranscripts(): void {
    this.db.sql.prepare("UPDATE dictation_history SET transcript = NULL").run();
    this.db.sql.prepare("UPDATE tasks SET transcript = NULL").run();
  }

  prune(): void {
    const days = Number(this.settings.get("history.retentionDays"));
    this.db.sql.prepare("DELETE FROM dictation_history WHERE created_at < ?").run(this.now() - days * DAY);
  }
}

interface TaskRow {
  id: string;
  status: string;
  transcript: string | null;
  reply: string | null;
  started_at: number;
  finished_at: number | null;
}

/** Task history. Transcript follows the same opt-in rule as dictation history. */
export class TaskRepo implements TaskStore {
  constructor(private readonly db: Database) {}

  save(task: TaskRecord): void {
    const sql = this.db.sql;
    sql.exec("BEGIN");
    try {
      sql
        .prepare(
          `INSERT INTO tasks (id, status, transcript, reply, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET status = excluded.status, transcript = excluded.transcript,
           reply = excluded.reply, finished_at = excluded.finished_at`,
        )
        .run(task.id, task.status, task.transcript, task.reply, task.startedAt, task.finishedAt);
      const step = sql.prepare(
        `INSERT OR REPLACE INTO task_steps (task_id, seq, tool, input_summary, result_summary, approval, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const s of task.steps) step.run(task.id, s.seq, s.tool, s.inputSummary, s.resultSummary, s.approval, s.at);
      sql.exec("COMMIT");
    } catch (error) {
      sql.exec("ROLLBACK");
      throw error;
    }
  }

  get(id: string): TaskRecord | undefined {
    const row = this.db.sql.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  list(options: { limit?: number; query?: string } = {}): TaskRecord[] {
    const rows = this.db.sql
      .prepare("SELECT * FROM tasks ORDER BY started_at DESC LIMIT ?")
      .all(options.query ? 1000 : (options.limit ?? 50)) as unknown as TaskRow[];
    const tasks = rows.map((row) => this.hydrate(row));
    const q = options.query?.toLowerCase();
    return (q ? tasks.filter((t) => matches(t, q)) : tasks).slice(0, options.limit ?? 50);
  }

  prune(before: number): void {
    this.db.sql.prepare("DELETE FROM tasks WHERE started_at < ?").run(before);
  }

  private hydrate(row: TaskRow): TaskRecord {
    const steps = this.db.sql
      .prepare(
        `SELECT seq, tool, input_summary AS inputSummary, result_summary AS resultSummary, approval, at
         FROM task_steps WHERE task_id = ? ORDER BY seq`,
      )
      .all(row.id) as unknown as Array<Omit<StepRecord, "isError">>;
    return {
      id: row.id,
      status: row.status as TaskStatus,
      transcript: row.transcript,
      reply: row.reply ?? "",
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      steps: steps.map((s) => ({ ...s, isError: false })),
    };
  }
}

interface ReminderRow {
  id: number;
  text: string;
  due_at: number;
  tz: string;
  repeat: string;
  status: string;
  task_id: string | null;
  missed: number;
}

const toReminder = (row: ReminderRow): Reminder => ({
  id: row.id,
  text: row.text,
  dueAt: row.due_at,
  tz: row.tz,
  repeat: row.repeat as Repeat,
  status: row.status as Reminder["status"],
  taskId: row.task_id,
  missed: row.missed === 1,
});

export class ReminderRepo implements ReminderStore {
  constructor(private readonly db: Database) {}

  create(r: NewReminder): Reminder {
    const result = this.db.sql
      .prepare("INSERT INTO reminders (text, due_at, tz, repeat, task_id) VALUES (?, ?, ?, ?, ?)")
      .run(r.text, r.dueAt, r.tz, r.repeat ?? "none", r.taskId ?? null);
    return this.get(Number(result.lastInsertRowid))!;
  }

  get(id: number): Reminder | undefined {
    const row = this.db.sql.prepare("SELECT * FROM reminders WHERE id = ?").get(id) as ReminderRow | undefined;
    return row ? toReminder(row) : undefined;
  }

  update(id: number, patch: Partial<Omit<Reminder, "id">>): void {
    const current = this.get(id);
    if (!current) return;
    const n = { ...current, ...patch };
    this.db.sql
      .prepare(
        "UPDATE reminders SET text = ?, due_at = ?, tz = ?, repeat = ?, status = ?, task_id = ?, missed = ? WHERE id = ?",
      )
      .run(n.text, n.dueAt, n.tz, n.repeat, n.status, n.taskId, n.missed ? 1 : 0, id);
  }

  due(now: number): Reminder[] {
    const rows = this.db.sql
      .prepare("SELECT * FROM reminders WHERE status = 'scheduled' AND due_at <= ? ORDER BY due_at")
      .all(now) as unknown as ReminderRow[];
    return rows.map(toReminder);
  }

  list(status?: Reminder["status"]): Reminder[] {
    const rows = (status
      ? this.db.sql.prepare("SELECT * FROM reminders WHERE status = ? ORDER BY due_at").all(status)
      : this.db.sql.prepare("SELECT * FROM reminders ORDER BY due_at").all()) as unknown as ReminderRow[];
    return rows.map(toReminder);
  }
}
