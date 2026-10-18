import { parseWhen } from "../reminders/parse.js";
import { REPEATS, type Repeat, type ReminderStore } from "../reminders/scheduler.js";
import { formatLocal } from "../reminders/time.js";
import { clip, objectSchema, str, type Connector, type ConnectorContext } from "./types.js";

function when(input: Record<string, unknown>, ctx: ConnectorContext): number | undefined {
  return parseWhen(str(input.when), ctx.clock.now(), ctx.timeZone);
}

export function remindersConnector(store: ReminderStore): Connector {
  return {
    id: "reminders",
    name: "Reminders",
    description: "Set, list and cancel reminders. Murmur shows them as notifications.",
    icon: "bell",
    auth: { type: "none" },
    status: "ready",
    actions: [
      {
        name: "create",
        description:
          'Set a reminder. "when" accepts an ISO 8601 time or phrases like "at 3", "tomorrow at 9am", "in 20 minutes".',
        inputSchema: objectSchema(
          {
            text: { type: "string", minLength: 1 },
            when: { type: "string", minLength: 1 },
            repeat: { type: "string", enum: REPEATS },
          },
          ["text", "when"],
        ),
        effects: { modifies: true },
        verb: "Save",
        fields: {
          text: { label: "Remind me to" },
          when: { label: "When", type: "datetime" },
          repeat: { label: "Repeat" },
        },
        summarize(input, ctx) {
          const due = when(input, ctx);
          const time =
            due === undefined
              ? `"${str(input.when)}" (time not understood)`
              : formatLocal(due, ctx.timeZone, ctx.locale);
          const repeat = str(input.repeat, "none");
          return `Remind "${clip(str(input.text))}" at ${time}${repeat !== "none" ? `, ${repeat}` : ""}`;
        },
        async run(input, ctx) {
          const due = when(input, ctx);
          if (due === undefined) throw new Error(`I couldn't understand the time "${str(input.when)}".`);
          const r = store.create({
            text: str(input.text),
            dueAt: due,
            tz: ctx.timeZone,
            repeat: str(input.repeat, "none") as Repeat,
          });
          return `Reminder ${r.id} set for ${formatLocal(r.dueAt, r.tz, ctx.locale)}.`;
        },
      },
      {
        name: "list",
        description: "List upcoming reminders.",
        inputSchema: objectSchema({}),
        effects: { readOnly: true },
        summarize: () => "List reminders",
        async run(_input, ctx) {
          const upcoming = store.list("scheduled");
          if (!upcoming.length) return "No upcoming reminders.";
          return upcoming
            .map(
              (r) =>
                `${r.id}. ${r.text} at ${formatLocal(r.dueAt, r.tz, ctx.locale)}${r.repeat !== "none" ? ` (${r.repeat})` : ""}`,
            )
            .join("\n");
        },
      },
      {
        name: "cancel",
        description: "Cancel a reminder by id.",
        inputSchema: objectSchema({ id: { type: "integer" } }, ["id"]),
        effects: { modifies: true },
        verb: "Save",
        summarize: (input) => {
          const r = store.get(Number(input.id));
          return r ? `Cancel reminder "${clip(r.text)}"` : `Cancel reminder ${String(input.id)}`;
        },
        async run(input) {
          const r = store.get(Number(input.id));
          if (!r || r.status !== "scheduled") throw new Error(`No upcoming reminder ${String(input.id)}.`);
          store.update(r.id, { status: "cancelled" });
          return `Cancelled "${r.text}".`;
        },
      },
    ],
  };
}
