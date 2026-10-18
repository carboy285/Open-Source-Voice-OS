import type { Clock } from "../core/types.js";
import { systemClock } from "../core/types.js";
import { addDays, wallTime } from "./time.js";

export type Repeat = "none" | "daily" | "weekdays" | "weekly";
export const REPEATS: Repeat[] = ["none", "daily", "weekdays", "weekly"];

export interface Reminder {
  id: number;
  text: string;
  /** UTC milliseconds. */
  dueAt: number;
  /** IANA zone at creation, for display and for repeating at the same wall time. */
  tz: string;
  repeat: Repeat;
  status: "scheduled" | "fired" | "cancelled";
  taskId: string | null;
  /** Set once a missed reminder has fired on startup. */
  missed: boolean;
}

export type NewReminder = Pick<Reminder, "text" | "dueAt" | "tz"> & Partial<Pick<Reminder, "repeat" | "taskId">>;

export interface ReminderStore {
  create(reminder: NewReminder): Reminder;
  get(id: number): Reminder | undefined;
  update(id: number, patch: Partial<Omit<Reminder, "id">>): void;
  /** Scheduled reminders with dueAt ≤ now, oldest first. */
  due(now: number): Reminder[];
  list(status?: Reminder["status"]): Reminder[];
}

export class MemoryReminderStore implements ReminderStore {
  private readonly rows = new Map<number, Reminder>();
  private nextId = 1;
  create(r: NewReminder): Reminder {
    const reminder: Reminder = {
      repeat: "none",
      taskId: null,
      ...r,
      id: this.nextId++,
      status: "scheduled",
      missed: false,
    };
    this.rows.set(reminder.id, reminder);
    return { ...reminder };
  }
  get(id: number): Reminder | undefined {
    const r = this.rows.get(id);
    return r && { ...r };
  }
  update(id: number, patch: Partial<Omit<Reminder, "id">>): void {
    const r = this.rows.get(id);
    if (r) Object.assign(r, patch);
  }
  due(now: number): Reminder[] {
    return this.list("scheduled").filter((r) => r.dueAt <= now);
  }
  list(status?: Reminder["status"]): Reminder[] {
    return [...this.rows.values()]
      .filter((r) => !status || r.status === status)
      .sort((a, b) => a.dueAt - b.dueAt)
      .map((r) => ({ ...r }));
  }
}

/** Next occurrence strictly after `after`, keeping the wall-clock time in the reminder's zone. */
export function nextOccurrence(dueAt: number, repeat: Repeat, tz: string, after: number): number | undefined {
  if (repeat === "none") return undefined;
  let next = dueAt;
  for (let guard = 0; guard < 4000; guard++) {
    next = addDays(next, repeat === "weekly" ? 7 : 1, tz);
    if (repeat === "weekdays") {
      const day = wallTime(next, tz).weekday;
      if (day === 0 || day === 6) continue;
    }
    if (next > after) return next;
  }
  return undefined;
}

export interface FireEvent {
  reminder: Reminder;
  /** True when it came due while Murmur was not running. */
  missed: boolean;
}

export interface SchedulerOptions {
  store: ReminderStore;
  onFire: (event: FireEvent) => void;
  clock?: Clock;
  intervalMs?: number;
}

export const SNOOZE_MS = 10 * 60 * 1000;

/** Checks every 30 s. Missed reminders fire once at startup; repeating ones move to their next occurrence. */
export class ReminderScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly clock: Clock;

  constructor(private readonly options: SchedulerOptions) {
    this.clock = options.clock ?? systemClock;
  }

  start(): void {
    this.fireDue(true);
    this.timer = setInterval(() => this.tick(), this.options.intervalMs ?? 30_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  tick(): void {
    this.fireDue(false);
  }

  /** Fires everything due. With `startup`, each one counts as missed. */
  fireDue(startup: boolean): FireEvent[] {
    const now = this.clock.now();
    const fired: FireEvent[] = [];
    for (const reminder of this.options.store.due(now)) {
      const next = nextOccurrence(reminder.dueAt, reminder.repeat, reminder.tz, now);
      if (next !== undefined) this.options.store.update(reminder.id, { dueAt: next, missed: startup });
      else this.options.store.update(reminder.id, { status: "fired", missed: startup });
      const event = { reminder: { ...reminder, missed: startup }, missed: startup };
      fired.push(event);
      this.options.onFire(event);
    }
    return fired;
  }

  /** Brings a reminder back in 10 minutes. A repeating one gets a separate one-off copy. */
  snooze(id: number): Reminder | undefined {
    const reminder = this.options.store.get(id);
    if (!reminder) return undefined;
    const dueAt = this.clock.now() + SNOOZE_MS;
    if (reminder.repeat !== "none") {
      return this.options.store.create({ text: reminder.text, dueAt, tz: reminder.tz, taskId: reminder.taskId });
    }
    this.options.store.update(id, { dueAt, status: "scheduled", missed: false });
    return this.options.store.get(id);
  }

  done(id: number): void {
    const reminder = this.options.store.get(id);
    if (reminder?.repeat === "none") this.options.store.update(id, { status: "fired" });
  }

  cancel(id: number): boolean {
    const reminder = this.options.store.get(id);
    if (!reminder || reminder.status === "cancelled") return false;
    this.options.store.update(id, { status: "cancelled" });
    return true;
  }
}
