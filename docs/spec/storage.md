# Local storage

One SQLite database in the per-user app data directory (macOS `~/Library/Application Support/Murmur`, Windows `%APPDATA%\Murmur`, Linux `$XDG_DATA_HOME/murmur` for development) (D). **Audio is never written to disk** (B-P1, D).

## Tables (D)

| Table | Columns (described) | Notes |
|-------|---------------------|-------|
| settings | key (text, primary), value (JSON text) | |
| dictionary | see `dictionary.md` fields; `spoken` stored as a JSON array | unique on lower(written) |
| corrections | inserted word, corrected word, seen_at | learning candidates; pruned after 7 days |
| dictation_history | id, created_at, app category, word count, duration ms, transcript text **nullable** | text written only when `history.saveTranscripts` is true (B-P3); otherwise null |
| tasks | id, status, transcript (nullable, same rule), reply, started_at, finished_at | |
| task_steps | task_id, seq, tool, input summary, result summary, approval (`auto`/`approved`/`edited`/`cancelled`/`expired`), at | |
| reminders | see `reminders.md` | |
| schema_version | single integer | migrations run in order at startup |

- Turning off `history.saveTranscripts` offers to delete the stored text (D).
- "Delete all data" in Settings removes the database file, `SOUL.md`, `MEMORY.md` and keychain entries (D).
- Memory lives beside the database as two Markdown files, `SOUL.md` and `MEMORY.md`, mode `0600` (`memory.md`). They are not in the database.
- Retention: history 30 days, tasks 30 days, both settings (D).
