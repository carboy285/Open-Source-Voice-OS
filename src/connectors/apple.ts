import { parseWhen } from "../reminders/parse.js";
import { addDays, formatLocal, wallTime, zoned } from "../reminders/time.js";
import { clip, objectSchema, str, strList, type Connector, type ConnectorContext } from "./types.js";

/** Asks the Mac app to run something with Apple's own Mail, Calendar, Reminders or Notes. */
export type NativeCall = (service: string, action: string, args: Record<string, unknown>) => Promise<unknown>;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const list = (v: unknown): Obj[] => (Array.isArray(obj(v).items) ? (obj(v).items as unknown[]).map(obj) : []);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const oneLine = (s: string, max: number) => clip(s.replace(/\s+/g, " ").trim(), max);

function time(input: Obj, key: string, ctx: ConnectorContext): number | undefined {
  const value = str(input[key]);
  return value ? parseWhen(value, ctx.clock.now(), ctx.timeZone) : undefined;
}

function startOfToday(ctx: ConnectorContext): number {
  const w = wallTime(ctx.clock.now(), ctx.timeZone);
  return zoned(w.year, w.month, w.day, 0, 0, ctx.timeZone);
}

function calendar(call: NativeCall): Connector {
  return {
    id: "apple_calendar",
    name: "Calendar (Mac)",
    description:
      "Read and add events in the Calendar app on this Mac, including iCloud and Google accounts added there.",
    icon: "calendar",
    auth: { type: "none" },
    status: "ready",
    actions: [
      {
        name: "events",
        description:
          'List events between two times (default: today through the next 7 days). "from" and "to" accept ISO 8601 or phrases like "tomorrow at 9am".',
        inputSchema: objectSchema({
          from: { type: "string" },
          to: { type: "string" },
          calendar: { type: "string", description: "Only this calendar." },
        }),
        effects: { readOnly: true },
        summarize: (input) => `List events${input.from ? ` from ${str(input.from)}` : ""}`,
        async run(input, ctx) {
          const from = time(input, "from", ctx) ?? startOfToday(ctx);
          const to = time(input, "to", ctx) ?? addDays(from, 7, ctx.timeZone);
          if (str(input.from) && time(input, "from", ctx) === undefined)
            throw new Error(`I couldn't understand "${str(input.from)}".`);
          if (str(input.to) && time(input, "to", ctx) === undefined)
            throw new Error(`I couldn't understand "${str(input.to)}".`);
          const events = list(
            await call("calendar", "events", { fromMs: from, toMs: to, calendar: str(input.calendar) }),
          );
          if (!events.length) return "No events in that time.";
          return events
            .map((e) => {
              const start = num(e.startMs);
              const when =
                start === undefined
                  ? ""
                  : e.allDay === true
                    ? `${formatLocal(start, ctx.timeZone, ctx.locale).split(",").slice(0, 2).join(",")} (all day)`
                    : formatLocal(start, ctx.timeZone, ctx.locale);
              const where = str(e.location) ? ` at ${oneLine(str(e.location), 60)}` : "";
              return `${when}: ${oneLine(str(e.title, "(no title)"), 100)}${where} [${str(e.calendar)}]`;
            })
            .join("\n");
        },
      },
      {
        name: "create_event",
        description: "Add an event to the Calendar app. The user reviews it first.",
        inputSchema: objectSchema(
          {
            title: { type: "string", minLength: 1 },
            start: { type: "string", minLength: 1 },
            end: { type: "string", description: "Default: one hour after the start." },
            calendar: { type: "string", description: "Calendar name. Default: the user's default calendar." },
            location: { type: "string" },
            notes: { type: "string" },
          },
          ["title", "start"],
        ),
        effects: { books: true, modifies: true },
        verb: "Book",
        fields: {
          title: { label: "Title" },
          start: { label: "Starts", type: "datetime" },
          end: { label: "Ends", type: "datetime" },
          calendar: { label: "Calendar" },
          location: { label: "Location" },
          notes: { label: "Notes", type: "longtext" },
        },
        summarize(input, ctx) {
          const start = time(input, "start", ctx);
          const when =
            start === undefined
              ? `"${str(input.start)}" (time not understood)`
              : formatLocal(start, ctx.timeZone, ctx.locale);
          return `Add "${oneLine(str(input.title), 50)}" to Calendar, ${when}`;
        },
        async run(input, ctx) {
          const start = time(input, "start", ctx);
          if (start === undefined) throw new Error(`I couldn't understand the time "${str(input.start)}".`);
          const end = time(input, "end", ctx) ?? start + 3_600_000;
          if (end <= start) throw new Error("The event has to end after it starts.");
          await call("calendar", "create", {
            title: str(input.title),
            startMs: start,
            endMs: end,
            calendar: str(input.calendar),
            location: str(input.location),
            notes: str(input.notes),
          });
          return `Added "${str(input.title)}" for ${formatLocal(start, ctx.timeZone, ctx.locale)}.`;
        },
      },
    ],
  };
}

function reminders(call: NativeCall): Connector {
  return {
    id: "apple_reminders",
    name: "Reminders (Mac)",
    description: "Read, add and finish items in the Reminders app on this Mac.",
    icon: "bell",
    auth: { type: "none" },
    status: "ready",
    actions: [
      {
        name: "list",
        description: "List unfinished reminders, soonest first. Optionally one list, or include finished ones.",
        inputSchema: objectSchema({
          list: { type: "string", description: "Only this Reminders list." },
          include_completed: { type: "boolean" },
        }),
        effects: { readOnly: true },
        summarize: (input) => `List reminders${input.list ? ` in ${str(input.list)}` : ""}`,
        async run(input, ctx) {
          const items = list(
            await call("reminders", "list", {
              list: str(input.list),
              includeCompleted: input.include_completed === true,
              limit: 50,
            }),
          );
          if (!items.length) return "No reminders.";
          return items
            .map((r) => {
              const due = num(r.dueMs);
              return `${str(r.id)}: ${r.completed === true ? "[done] " : ""}${oneLine(str(r.title, "(no title)"), 100)}${due !== undefined ? `, due ${formatLocal(due, ctx.timeZone, ctx.locale)}` : ""} [${str(r.list)}]`;
            })
            .join("\n");
        },
      },
      {
        name: "lists",
        description: "Name the Reminders lists.",
        inputSchema: objectSchema({}),
        effects: { readOnly: true },
        summarize: () => "List Reminders lists",
        async run() {
          const names = list(await call("reminders", "lists", {})).map((l) => str(l.name));
          return names.length ? names.join("\n") : "No lists.";
        },
      },
      {
        name: "create",
        description:
          'Add a reminder to the Reminders app. "due" accepts ISO 8601 or phrases like "tomorrow at 9am". The user reviews it first.',
        inputSchema: objectSchema(
          {
            title: { type: "string", minLength: 1 },
            due: { type: "string" },
            list: { type: "string", description: "List name. Default: the user's default list." },
            notes: { type: "string" },
          },
          ["title"],
        ),
        effects: { modifies: true },
        verb: "Save",
        fields: {
          title: { label: "Remind me to" },
          due: { label: "When", type: "datetime" },
          list: { label: "List" },
          notes: { label: "Notes", type: "longtext" },
        },
        summarize(input, ctx) {
          const due = time(input, "due", ctx);
          return `Add "${oneLine(str(input.title), 60)}" to Reminders${due !== undefined ? `, due ${formatLocal(due, ctx.timeZone, ctx.locale)}` : ""}`;
        },
        async run(input, ctx) {
          const due = time(input, "due", ctx);
          if (str(input.due) && due === undefined)
            throw new Error(`I couldn't understand the time "${str(input.due)}".`);
          await call("reminders", "create", {
            title: str(input.title),
            dueMs: due,
            list: str(input.list),
            notes: str(input.notes),
          });
          return `Added "${str(input.title)}" to Reminders.`;
        },
      },
      {
        name: "complete",
        description: "Mark a reminder finished, by the id that `list` returned.",
        inputSchema: objectSchema({ id: { type: "string", minLength: 1 } }, ["id"]),
        effects: { modifies: true },
        verb: "Save",
        summarize: () => "Mark a reminder as done",
        async run(input) {
          const done = obj(await call("reminders", "complete", { id: str(input.id) }));
          return `Marked "${str(done.title, "the reminder")}" as done.`;
        },
      },
    ],
  };
}

function mail(call: NativeCall): Connector {
  return {
    id: "apple_mail",
    name: "Mail (Mac)",
    description:
      "Read your inbox in the Mail app on this Mac (every account added there), and start a draft. It never sends.",
    icon: "mail",
    auth: { type: "none" },
    status: "ready",
    actions: [
      {
        name: "recent",
        description:
          "List the newest inbox messages: id, sender, subject, date. Optionally only unread, or only those whose sender or subject contains some text (searches the latest 200).",
        inputSchema: objectSchema({
          limit: { type: "integer", minimum: 1, maximum: 25 },
          unread_only: { type: "boolean" },
          contains: { type: "string" },
        }),
        effects: { readOnly: true },
        summarize: (input) =>
          input.contains ? `Search mail for "${clip(str(input.contains), 40)}"` : "List recent mail",
        async run(input, ctx) {
          const messages = list(
            await call("mail", "recent", {
              limit: Math.min(25, Math.max(1, num(input.limit) ?? 10)),
              unreadOnly: input.unread_only === true,
              query: str(input.contains),
            }),
          );
          if (!messages.length) return "No matching mail.";
          return messages
            .map((m) => {
              const date = num(m.dateMs);
              return `${str(m.id)}: ${m.read === false ? "[unread] " : ""}${oneLine(str(m.sender), 60)}: ${oneLine(str(m.subject, "(no subject)"), 100)}${date !== undefined ? ` (${formatLocal(date, ctx.timeZone, ctx.locale)})` : ""}`;
            })
            .join("\n");
        },
      },
      {
        name: "read",
        description: "Read one message from the inbox, by the id that `recent` returned.",
        inputSchema: objectSchema({ id: { type: "string", minLength: 1 } }, ["id"]),
        effects: { readOnly: true },
        summarize: () => "Read a message",
        async run(input, ctx) {
          const m = obj(await call("mail", "read", { id: str(input.id) }));
          const date = num(m.dateMs);
          return [
            `From: ${str(m.sender)}`,
            str(m.to) ? `To: ${str(m.to)}` : "",
            `Subject: ${str(m.subject)}`,
            date !== undefined ? `Date: ${formatLocal(date, ctx.timeZone, ctx.locale)}` : "",
            "",
            clip(str(m.body), 6000),
          ]
            .filter((line, i) => line || i > 3)
            .join("\n");
        },
      },
      {
        name: "draft",
        description: "Open a new draft in Mail for the user to finish and send. It is not sent.",
        inputSchema: objectSchema(
          {
            to: { type: "array", items: { type: "string", format: "email" } },
            subject: { type: "string" },
            body: { type: "string" },
          },
          ["subject", "body"],
        ),
        effects: { modifies: true },
        verb: "Save",
        fields: {
          to: { label: "To", type: "recipients" },
          subject: { label: "Subject" },
          body: { label: "Message", type: "longtext" },
        },
        summarize: (input) => `Start a draft in Mail: "${clip(str(input.subject), 50)}"`,
        async run(input) {
          await call("mail", "draft", { to: strList(input.to), subject: str(input.subject), body: str(input.body) });
          return "Opened a draft in Mail. The user still has to send it.";
        },
      },
    ],
  };
}

function notes(call: NativeCall): Connector {
  return {
    id: "apple_notes",
    name: "Notes (Mac)",
    description: "Save a note in the Notes app on this Mac.",
    icon: "note",
    auth: { type: "none" },
    status: "ready",
    actions: [
      {
        name: "create",
        description: "Create a note in the Notes app. The user reviews it first.",
        inputSchema: objectSchema(
          {
            title: { type: "string", minLength: 1 },
            body: { type: "string", description: "Plain text. Line breaks are kept." },
          },
          ["title"],
        ),
        effects: { modifies: true },
        verb: "Save",
        fields: { title: { label: "Title" }, body: { label: "Note", type: "longtext" } },
        summarize: (input) => `Save a note in Notes: "${oneLine(str(input.title), 50)}"`,
        async run(input) {
          await call("notes", "create", { title: str(input.title), body: str(input.body) });
          return `Saved the note "${str(input.title)}" in Notes.`;
        },
      },
    ],
  };
}

/** Mail, Calendar, Reminders and Notes on a Mac. The Mac app does the work; these describe it to the agent. */
export function appleConnectors(call: NativeCall): Connector[] {
  return [mail(call), calendar(call), reminders(call), notes(call)];
}
