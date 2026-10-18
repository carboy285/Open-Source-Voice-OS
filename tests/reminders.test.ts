import { describe, expect, it } from "vitest";
import { parseWhen } from "../src/reminders/parse.js";
import { MemoryReminderStore, nextOccurrence, ReminderScheduler, type FireEvent } from "../src/reminders/scheduler.js";
import { wallTime, zoned } from "../src/reminders/time.js";
import { Database } from "../src/storage/db.js";
import { ReminderRepo } from "../src/storage/repos.js";

const TZ = "America/New_York";
const at = (y: number, mo: number, d: number, h: number, mi = 0, tz = TZ) => zoned(y, mo, d, h, mi, tz);

describe("parseWhen", () => {
  it('reads "at 3" said at 4 pm as 3 pm tomorrow', () => {
    expect(parseWhen("at 3", at(2026, 10, 18, 16), TZ)).toBe(at(2026, 10, 19, 15));
  });

  it('reads "at 3" said at 10 am as 3 pm today', () => {
    expect(parseWhen("at 3", at(2026, 10, 18, 10), TZ)).toBe(at(2026, 10, 18, 15));
  });

  it("picks the next future occurrence for 7 to 11", () => {
    expect(parseWhen("at 9", at(2026, 10, 18, 10), TZ)).toBe(at(2026, 10, 18, 21));
    expect(parseWhen("at 9", at(2026, 10, 18, 22), TZ)).toBe(at(2026, 10, 19, 9));
  });

  it("handles explicit am/pm, minutes, days and relative times", () => {
    const now = at(2026, 10, 18, 16);
    expect(parseWhen("at 3am", now, TZ)).toBe(at(2026, 10, 19, 3));
    expect(parseWhen("tomorrow at 9:30", now, TZ)).toBe(at(2026, 10, 19, 9, 30));
    expect(parseWhen("in 10 minutes", now, TZ)).toBe(now + 600_000);
    expect(parseWhen("monday at 8am", now, TZ)).toBe(at(2026, 10, 19, 8));
    expect(parseWhen("2026-10-20T12:00:00Z", now, TZ)).toBe(Date.parse("2026-10-20T12:00:00Z"));
    expect(parseWhen("next blue moon", now, TZ)).toBeUndefined();
  });

  it("understands Japanese times", () => {
    const now = at(2026, 10, 18, 16, 0, "Asia/Tokyo");
    expect(parseWhen("明日 午後3時", now, "Asia/Tokyo")).toBe(at(2026, 10, 19, 15, 0, "Asia/Tokyo"));
    expect(parseWhen("3時半", now, "Asia/Tokyo")).toBe(at(2026, 10, 19, 15, 30, "Asia/Tokyo"));
  });
});

describe("ReminderScheduler", () => {
  function setup(now: { t: number }) {
    const store = new MemoryReminderStore();
    const fired: FireEvent[] = [];
    const scheduler = new ReminderScheduler({ store, clock: { now: () => now.t }, onFire: (e) => fired.push(e) });
    return { store, fired, scheduler };
  }

  it("fires a missed reminder once on startup", () => {
    const now = { t: at(2026, 10, 18, 12) };
    const { store, fired, scheduler } = setup(now);
    store.create({ text: "Call Ana", dueAt: at(2026, 10, 18, 9), tz: TZ });
    scheduler.fireDue(true);
    scheduler.tick();
    scheduler.fireDue(true);
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ missed: true, reminder: { text: "Call Ana" } });
    expect(store.list()[0]).toMatchObject({ status: "fired", missed: true });
  });

  it("fires when due and not before", () => {
    const now = { t: at(2026, 10, 18, 8) };
    const { store, fired, scheduler } = setup(now);
    store.create({ text: "Stand-up", dueAt: at(2026, 10, 18, 9), tz: TZ });
    scheduler.tick();
    expect(fired).toHaveLength(0);
    now.t = at(2026, 10, 18, 9);
    scheduler.tick();
    expect(fired).toMatchObject([{ missed: false }]);
  });

  it("moves a repeating reminder to its next occurrence", () => {
    const now = { t: at(2026, 10, 16, 9) }; // Friday
    const { store, fired, scheduler } = setup(now);
    const r = store.create({ text: "Timesheet", dueAt: now.t, tz: TZ, repeat: "weekdays" });
    scheduler.tick();
    expect(fired).toHaveLength(1);
    expect(store.get(r.id)).toMatchObject({ status: "scheduled", dueAt: at(2026, 10, 19, 9) }); // Monday
  });

  it("fires a repeating reminder missed for days only once", () => {
    const now = { t: at(2026, 10, 18, 12) };
    const { store, fired, scheduler } = setup(now);
    const r = store.create({ text: "Water plants", dueAt: at(2026, 10, 10, 8), tz: TZ, repeat: "daily" });
    scheduler.fireDue(true);
    expect(fired).toHaveLength(1);
    expect(store.get(r.id)?.dueAt).toBe(at(2026, 10, 19, 8));
  });

  it("keeps the wall-clock time across a DST change", () => {
    const next = nextOccurrence(at(2026, 10, 31, 9), "daily", TZ, at(2026, 10, 31, 10));
    expect(wallTime(next!, TZ)).toMatchObject({ month: 11, day: 1, hour: 9 });
    expect(nextOccurrence(at(2026, 10, 18, 9), "weekly", TZ, at(2026, 10, 18, 10))).toBe(at(2026, 10, 25, 9));
  });

  it("snoozes for 10 minutes and cancels", () => {
    const now = { t: at(2026, 10, 18, 9) };
    const { store, scheduler } = setup(now);
    const r = store.create({ text: "Tea", dueAt: now.t, tz: TZ });
    scheduler.tick();
    expect(scheduler.snooze(r.id)?.dueAt).toBe(now.t + 600_000);
    expect(scheduler.cancel(r.id)).toBe(true);
    expect(store.get(r.id)?.status).toBe("cancelled");
  });

  it("works on the SQLite store", () => {
    const db = new Database();
    const store = new ReminderRepo(db);
    const fired: FireEvent[] = [];
    const scheduler = new ReminderScheduler({ store, clock: { now: () => 2000 }, onFire: (e) => fired.push(e) });
    store.create({ text: "a", dueAt: 1000, tz: "UTC" });
    scheduler.fireDue(true);
    scheduler.fireDue(true);
    expect(fired).toHaveLength(1);
    expect(store.list("fired")[0]?.missed).toBe(true);
    db.close();
  });
});
