/** Wall-clock helpers for IANA time zones, using only Intl. */
export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday. */
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

export function wallTime(ts: number, tz: string): WallTime {
  const parts = Object.fromEntries(
    formatter(tz)
      .formatToParts(new Date(ts))
      .map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAYS.indexOf(parts.weekday ?? "Sun"),
  };
}

function offset(ts: number, tz: string): number {
  const w = wallTime(ts, tz);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - Math.floor(ts / 60_000) * 60_000;
}

/** UTC timestamp of a wall-clock time in `tz`. Day overflow (day 32) rolls over like Date.UTC. */
export function zoned(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let ts = guess - offset(guess, tz);
  ts = guess - offset(ts, tz);
  return ts;
}

/** Same wall-clock time `days` later. */
export function addDays(ts: number, days: number, tz: string): number {
  const w = wallTime(ts, tz);
  return zoned(w.year, w.month, w.day + days, w.hour, w.minute, tz);
}

export const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Formats a time for the approval preview in the user's locale. */
export function formatLocal(ts: number, tz: string, locale = "en-US"): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ts));
}
