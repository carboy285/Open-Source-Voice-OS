import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Database } from "../src/storage/db.js";
import { MIGRATIONS } from "../src/storage/migrations.js";
import { DictationHistoryRepo, DictionaryRepo, SettingsRepo, TaskRepo } from "../src/storage/repos.js";

describe("storage", () => {
  it("runs migrations once and records the schema version", () => {
    const dir = mkdtempSync(join(tmpdir(), "murmur-"));
    const path = join(dir, "murmur.db");
    new Database(path).close();
    const db = new Database(path);
    expect(db.version).toBe(MIGRATIONS.length);
    db.close();
  });

  it("stores no transcript text unless saveTranscripts is on", () => {
    const db = new Database();
    const settings = new SettingsRepo(db);
    const history = new DictationHistoryRepo(db, settings);
    expect(settings.get("history.saveTranscripts")).toBe(false);
    history.record({ category: "email", text: "Secret plans for Q3", durationMs: 1200 });
    expect(history.list()[0]).toMatchObject({ transcript: null, wordCount: 4, category: "email" });
    const dump = JSON.stringify(db.sql.prepare("SELECT * FROM dictation_history").all());
    expect(dump).not.toContain("Secret");

    settings.set("history.saveTranscripts", true);
    history.record({ category: "chat", text: "hello there", durationMs: 500 });
    expect(history.list()[0]?.transcript).toBe("hello there");
    history.clearTranscripts();
    expect(history.list().every((r) => r.transcript === null)).toBe(true);
    db.close();
  });

  it("stores task transcripts only when given", () => {
    const db = new Database();
    const tasks = new TaskRepo(db);
    tasks.save({ id: "t1", status: "done", transcript: null, reply: "Sent.", startedAt: 1, finishedAt: 2, steps: [] });
    expect(tasks.get("t1")?.transcript).toBeNull();
    db.close();
  });

  it("delete-all removes the database file", () => {
    const dir = mkdtempSync(join(tmpdir(), "murmur-"));
    const path = join(dir, "murmur.db");
    const db = new Database(path);
    new SettingsRepo(db).set("ui.locale", "ja");
    db.destroy();
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}-wal`)).toBe(false);
    const fresh = new Database(path);
    expect(new SettingsRepo(fresh).get("ui.locale")).toBe("system");
    fresh.close();
  });

  it("keeps dictionary written forms unique and merges variants", () => {
    const db = new Database();
    const dict = new DictionaryRepo(db);
    dict.add({ written: "PostgreSQL", spoken: ["postgres q l"] });
    const merged = dict.add({ written: "postgresql", spoken: ["postgres sequel"] });
    expect(dict.list()).toHaveLength(1);
    expect(merged.spoken).toEqual(["postgres q l", "postgres sequel"]);
    expect(dict.add({ written: "NASA", kind: "acronym" }).caseSensitive).toBe(true);
    db.close();
  });
});
