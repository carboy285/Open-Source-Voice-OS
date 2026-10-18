import { parseWhen } from "../reminders/parse.js";
import { addDays, wallTime } from "../reminders/time.js";

/**
 * The shape an approval preview takes in the notch. The core works it out from what the tool is doing and the
 * input it was given, so the shell only draws it: an event looks like an event, an email like an email. Nothing
 * here comes from the model's own words except the values it filled in, and a shell shows those as plain text.
 */
export type CardKind = "event" | "email" | "reminder" | "message" | "file" | "agent" | "generic";

export interface CardRow {
  /** Icon id the shell maps to its own symbol: clock, person, pin, text, link, folder, list. */
  icon: string;
  /** "chips" shows each value as a small pill, "body" as a short paragraph, "text" as one line. */
  style: "text" | "chips" | "body";
  label?: string;
  values: string[];
}

export interface Card {
  kind: CardKind;
  /** Icon id of the app, from the connector. */
  icon: string;
  app: string;
  title: string;
  rows: CardRow[];
  /** A short extra, such as a video call that will be added. */
  badge?: { icon: string; text: string };
}

export interface CardContext {
  now: number;
  timeZone: string;
  locale: string;
}

type Input = Record<string, unknown>;
const squash = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, "");

/** First non-empty value among the candidate keys, matched ignoring case and separators. */
function pick(input: Input, ...names: string[]): unknown {
  const byName = new Map(Object.keys(input).map((k) => [squash(k), k]));
  for (const name of names) {
    const key = byName.get(squash(name));
    if (key === undefined) continue;
    const value = input[key];
    if (value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length)) continue;
    return value;
  }
  return undefined;
}

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const clip = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

function list(v: unknown): string[] {
  const items = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;\n]/) : [];
  return items
    .map((item) => {
      if (item && typeof item === "object") {
        const o = item as Input;
        return text(o.email) || text(o.address) || text(o.name) || "";
      }
      return text(item);
    })
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function instant(value: unknown, ctx: CardContext): { at: number; dateOnly: boolean } | undefined {
  if (typeof value === "number" && Number.isFinite(value))
    return { at: value < 1e11 ? value * 1000 : value, dateOnly: false };
  const raw = text(value);
  if (!raw) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const at = parseWhen(`${raw}T00:00`, ctx.now, ctx.timeZone);
    return at === undefined ? undefined : { at, dateOnly: true };
  }
  const at = parseWhen(raw, ctx.now, ctx.timeZone);
  return at === undefined ? undefined : { at, dateOnly: false };
}

const ymd = (ts: number, tz: string) => {
  const w = wallTime(ts, tz);
  return w.year * 10_000 + w.month * 100 + w.day;
};

function dayLabel(ts: number, ctx: CardContext): string {
  const today = ymd(ctx.now, ctx.timeZone);
  if (ymd(ts, ctx.timeZone) === today) return "Today";
  if (ymd(ts, ctx.timeZone) === ymd(addDays(ctx.now, 1, ctx.timeZone), ctx.timeZone)) return "Tomorrow";
  const soon = ts > ctx.now && ts < ctx.now + 6 * 86_400_000;
  return new Intl.DateTimeFormat(ctx.locale, {
    timeZone: ctx.timeZone,
    weekday: soon ? "long" : "short",
    ...(soon ? {} : { month: "short", day: "numeric" }),
  }).format(new Date(ts));
}

const clock = (ts: number, ctx: CardContext) =>
  new Intl.DateTimeFormat(ctx.locale, { timeZone: ctx.timeZone, hour: "numeric", minute: "2-digit" }).format(
    new Date(ts),
  );

/** "Thursday · 2:00 – 2:30 PM". The shared AM/PM is written once. */
export function whenLabel(start: unknown, end: unknown, ctx: CardContext): string | undefined {
  const from = instant(start, ctx);
  if (!from) return undefined;
  const day = dayLabel(from.at, ctx);
  if (from.dateOnly) return `${day} · All day`;
  const to = instant(end, ctx);
  const first = clock(from.at, ctx);
  if (!to || to.dateOnly || to.at <= from.at) return `${day} · ${first}`;
  const last = clock(to.at, ctx);
  const sameDay = ymd(to.at, ctx.timeZone) === ymd(from.at, ctx.timeZone);
  const meridiem = / ?[AP]M$/i;
  const short = sameDay && meridiem.exec(first)?.[0] === meridiem.exec(last)?.[0] ? first.replace(meridiem, "") : first;
  return sameDay ? `${day} · ${short} – ${last}` : `${day} ${first} – ${dayLabel(to.at, ctx)} ${last}`;
}

function kindOf(tool: string, input: Input): CardKind {
  const name = tool.toLowerCase();
  if (
    /calendar|event|meeting|schedule/.test(name) ||
    (pick(input, "start", "start_time", "start_datetime", "startTime") && pick(input, "title", "summary"))
  )
    return "event";
  if (/mail|draft|inbox|outlook/.test(name) || (pick(input, "to", "recipients") && pick(input, "subject")))
    return "email";
  if (/remind|todo|task/.test(name)) return "reminder";
  if (/slack|discord|chat|channel|message|telegram|whatsapp|teams/.test(name)) return "message";
  if (/file|folder|drive|path|note|obsidian|vault/.test(name)) return "file";
  return "generic";
}

export function buildCard(
  tool: { name: string; icon: string; app: string; title?: string },
  input: Input,
  summary: string,
  ctx: CardContext,
): Card {
  const kind = kindOf(tool.name, input);
  const rows: CardRow[] = [];
  const add = (row: CardRow | undefined) => row && row.values.some(Boolean) && rows.push(row);
  const one = (icon: string, value: unknown, label?: string): CardRow | undefined => {
    const v = clip(text(value), 140);
    return v ? { icon, style: "text", label, values: [v] } : undefined;
  };
  let title = "";
  let badge: Card["badge"];

  if (kind === "event") {
    title = text(pick(input, "title", "summary", "subject", "name"));
    const start = pick(input, "start", "start_time", "start_datetime", "startTime", "start_at", "when");
    let end = pick(input, "end", "end_time", "end_datetime", "endTime", "end_at");
    const minutes = Number(pick(input, "event_duration_minutes", "duration_minutes", "duration") ?? NaN);
    const hours = Number(pick(input, "event_duration_hour", "duration_hours") ?? NaN);
    const begin = instant(start, ctx);
    if (!end && begin && (Number.isFinite(minutes) || Number.isFinite(hours))) {
      end = begin.at + ((Number.isFinite(hours) ? hours * 60 : 0) + (Number.isFinite(minutes) ? minutes : 0)) * 60_000;
    }
    const when = whenLabel(start, end, ctx);
    add(when ? { icon: "clock", style: "text", values: [when] } : one("clock", start));
    add({
      icon: "person",
      style: "chips",
      values: list(pick(input, "attendees", "guests", "invitees", "attendee_emails")),
    });
    add(one("pin", pick(input, "location", "where")));
    add(one("text", clip(text(pick(input, "description", "notes", "details")), 120)));
    const wantsMeet =
      /meet/i.test(tool.name) ||
      pick(input, "create_meeting_room", "add_google_meet", "google_meet", "conferenceData", "conference") === true ||
      Boolean(pick(input, "conferenceData", "conference_data"));
    if (wantsMeet) badge = { icon: "video", text: "Google Meet" };
  } else if (kind === "email") {
    title = text(pick(input, "subject", "title"));
    add({
      icon: "person",
      style: "chips",
      label: "To",
      values: list(pick(input, "to", "recipients", "recipient_email", "recipient")),
    });
    add({ icon: "person", style: "chips", label: "Cc", values: list(pick(input, "cc")) });
    const body = text(pick(input, "body", "content", "message", "text"));
    if (body) add({ icon: "text", style: "body", values: [clip(body, 220)] });
  } else if (kind === "reminder") {
    title = text(pick(input, "title", "text", "name", "summary", "task"));
    const when = whenLabel(pick(input, "due", "when", "due_date", "due_at", "dueAt", "remind_at"), undefined, ctx);
    add(when ? { icon: "clock", style: "text", values: [when] } : undefined);
    add(one("list", pick(input, "list", "project", "repeat")));
    add(one("text", clip(text(pick(input, "notes", "description")), 120)));
  } else if (kind === "message") {
    title = text(pick(input, "channel", "to", "recipient", "chat", "thread")) || tool.app;
    const body = text(pick(input, "text", "message", "body", "content"));
    if (body) add({ icon: "text", style: "body", values: [clip(body, 220)] });
  } else if (kind === "file") {
    title = text(pick(input, "title", "name", "path", "file", "filename"));
    add(one("folder", pick(input, "path", "folder", "destination", "to", "directory")));
    const body = text(pick(input, "content", "text", "body", "markdown"));
    if (body) add({ icon: "text", style: "body", values: [clip(body, 160)] });
  }

  if (!title) title = clip(summary, 120);
  if (kind === "generic") {
    // No special layout: the first few filled-in values, as the model gave them.
    for (const [key, value] of Object.entries(input).slice(0, 4)) {
      const v = Array.isArray(value) ? list(value).join(", ") : typeof value === "object" && value ? "" : text(value);
      if (v) add({ icon: "text", style: "text", label: key.replace(/[_-]+/g, " "), values: [clip(v, 100)] });
    }
  }
  return {
    kind,
    icon: tool.icon,
    app: tool.app,
    title: clip(title, 140),
    rows: rows.slice(0, 5),
    ...(badge ? { badge } : {}),
  };
}
