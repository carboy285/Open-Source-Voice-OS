/** Schema migrations, applied in order at startup. Never edit a shipped entry; append a new one. */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE dictionary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    written TEXT NOT NULL,
    spoken TEXT NOT NULL DEFAULT '[]',
    kind TEXT NOT NULL DEFAULT 'term',
    case_sensitive INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'manual',
    uses INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX dictionary_written ON dictionary (lower(written));
  CREATE TABLE corrections (inserted TEXT NOT NULL, corrected TEXT NOT NULL, seen_at INTEGER NOT NULL);
  CREATE INDEX corrections_pair ON corrections (inserted, corrected, seen_at);
  CREATE TABLE dictation_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    category TEXT NOT NULL,
    word_count INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    transcript TEXT
  );
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    transcript TEXT,
    reply TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE TABLE task_steps (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    tool TEXT NOT NULL,
    input_summary TEXT NOT NULL,
    result_summary TEXT NOT NULL,
    approval TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (task_id, seq)
  );
  CREATE TABLE reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    tz TEXT NOT NULL,
    repeat TEXT NOT NULL DEFAULT 'none',
    status TEXT NOT NULL DEFAULT 'scheduled',
    task_id TEXT,
    missed INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX reminders_due ON reminders (status, due_at);
  `,
];
