import { addDays, wallTime, zoned } from "./time.js";

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * Parses a reminder time. Accepts ISO timestamps, "in 10 minutes", and
 * "[today|tomorrow|<weekday>] [at] 3[:30][am|pm]" (plus 明日/今日/午後 and 3時半 in Japanese).
 * A time without a date means its next future occurrence: "at 3" said at 4 pm is 3 pm tomorrow.
 * A bare hour from 1 to 6 means the afternoon.
 */
export function parseWhen(input: string, now: number, tz: string): number | undefined {
  const text = input.trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(:\d{2}(\.\d+)?)?(z|[+-]\d{2}:?\d{2})$/.test(text)) return Date.parse(input);
  const local = text.match(/^(\d{4})-(\d{2})-(\d{2})[t ](\d{2}):(\d{2})/);
  if (local) {
    const [, y, mo, d, h, mi] = local.map(Number) as [number, number, number, number, number, number];
    return zoned(y, mo, d, h, mi, tz);
  }

  const rel = text.match(/^in\s+(\d+|an?|one)\s+(minute|min|hour|hr|day)s?$/);
  if (rel) {
    const n = /^\d+$/.test(rel[1]!) ? Number(rel[1]) : 1;
    const unit = rel[2]!.startsWith("m") ? 60_000 : rel[2]!.startsWith("h") ? 3_600_000 : 86_400_000;
    return now + n * unit;
  }
  const jaRel = text.match(/^(\d+)\s*(分|時間|日)後$/);
  if (jaRel) {
    const unit = jaRel[2] === "分" ? 60_000 : jaRel[2] === "時間" ? 3_600_000 : 86_400_000;
    return now + Number(jaRel[1]) * unit;
  }

  let dayOffset: number | undefined;
  let weekday: number | undefined;
  let rest = text;
  const dayMatch = rest.match(/\b(today|tonight|tomorrow)\b|(今日|今夜|明日|あした|明後日)/);
  if (dayMatch) {
    const word = dayMatch[0];
    dayOffset = word === "tomorrow" || word === "明日" || word === "あした" ? 1 : word === "明後日" ? 2 : 0;
    rest = rest.replace(word, " ");
  } else {
    const named = DAY_NAMES.findIndex((d) => new RegExp(`\\b(on\\s+)?${d}\\b`).test(rest));
    if (named >= 0) {
      weekday = named;
      rest = rest.replace(new RegExp(`\\b(on\\s+)?${DAY_NAMES[named]}\\b`), " ");
    }
  }
  const pmHint = /\btonight\b|今夜/.test(text);

  const parsed = parseClock(rest.trim());
  if (!parsed && dayOffset === undefined && weekday === undefined) return undefined;
  if (!parsed && rest.trim()) return undefined;
  const time: Clock = parsed ?? { hours: [9], minute: 0, explicit: false };
  const nowWall = wallTime(now, tz);
  const base = zoned(nowWall.year, nowWall.month, nowWall.day, 0, 0, tz);
  const hours = pmHint ? time.hours.map((h) => (h < 12 ? h + 12 : h)) : time.hours;
  const at = (days: number, hour: number) => {
    const d = addDays(base, days, tz);
    const w = wallTime(d, tz);
    return zoned(w.year, w.month, w.day, hour, time.minute, tz);
  };

  if (dayOffset !== undefined) return at(dayOffset, hours[0]!);
  if (weekday !== undefined) {
    for (let days = 0; days <= 7; days++) {
      if ((nowWall.weekday + days) % 7 !== weekday) continue;
      const ts = at(days, hours[0]!);
      if (ts > now) return ts;
    }
  }
  const candidates = [0, 1].flatMap((days) => hours.map((h) => at(days, h))).filter((ts) => ts > now);
  return candidates.length ? Math.min(...candidates) : undefined;
}

interface Clock {
  /** Candidate hours in 24 h, in preference order. */
  hours: number[];
  minute: number;
  explicit: boolean;
}

function parseClock(text: string): Clock | undefined {
  const s = text
    .replace(/^at\s+/, "")
    .replace(/に$/, "")
    .trim();
  if (!s) return undefined;
  if (/^noon$|^正午$/.test(s)) return { hours: [12], minute: 0, explicit: true };
  if (/^midnight$/.test(s)) return { hours: [0], minute: 0, explicit: true };

  const ja = s.match(/^(午前|午後)?\s*(\d{1,2})時(?:\s*(\d{1,2})分|(半))?$/);
  if (ja) {
    let h = Number(ja[2]);
    const minute = ja[4] ? 30 : Number(ja[3] ?? 0);
    if (ja[1] === "午後" && h < 12) h += 12;
    if (ja[1] === "午前" && h === 12) h = 0;
    return ja[1] || h > 12 ? { hours: [h], minute, explicit: true } : { hours: bareHours(h), minute, explicit: false };
  }

  const en = s.match(/^(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|o'?clock)?$/);
  if (!en) return undefined;
  let h = Number(en[1]);
  const minute = Number(en[2] ?? 0);
  if (h > 23 || minute > 59) return undefined;
  const suffix = en[3]?.replace(/\./g, "");
  if (suffix === "pm" && h < 12) h += 12;
  if (suffix === "am" && h === 12) h = 0;
  if (suffix === "am" || suffix === "pm" || h > 12 || h === 0) return { hours: [h], minute, explicit: true };
  return { hours: bareHours(h), minute, explicit: false };
}

function bareHours(h: number): number[] {
  if (h === 12) return [12];
  if (h >= 1 && h <= 6) return [h + 12];
  return [h, h + 12];
}
