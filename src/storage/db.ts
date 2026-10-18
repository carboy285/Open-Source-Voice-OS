import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "./migrations.js";

/** The single SQLite database. Audio is never written here or anywhere else. */
export class Database {
  readonly sql: DatabaseSync;

  constructor(readonly path: string = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.sql = new DatabaseSync(path);
    this.sql.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  get version(): number {
    const row = this.sql.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
    return row?.version ?? 0;
  }

  private migrate(): void {
    this.sql.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
    if (!this.sql.prepare("SELECT 1 FROM schema_version").get()) {
      this.sql.prepare("INSERT INTO schema_version (version) VALUES (0)").run();
    }
    for (let v = this.version; v < MIGRATIONS.length; v++) {
      this.sql.exec("BEGIN");
      try {
        this.sql.exec(MIGRATIONS[v]!);
        this.sql.prepare("UPDATE schema_version SET version = ?").run(v + 1);
        this.sql.exec("COMMIT");
      } catch (error) {
        this.sql.exec("ROLLBACK");
        throw error;
      }
    }
  }

  close(): void {
    if (this.sql.isOpen) this.sql.close();
  }

  /** Closes and removes the database file and its WAL files. */
  destroy(): void {
    this.close();
    if (this.path === ":memory:") return;
    for (const suffix of ["", "-wal", "-shm"]) rmSync(this.path + suffix, { force: true });
  }
}
