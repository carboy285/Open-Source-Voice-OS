import { formatLocal } from "../../reminders/time.js";
import { clip, objectSchema, str, strList, type Connector } from "../types.js";
import { apiJson, clientIdSetting, GOOGLE_AUTH } from "./http.js";

const self = { id: "calendar", name: "Google Calendar" };
const BASE = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export function calendarConnector(): Connector {
  return {
    ...self,
    description: "See upcoming events and book new ones in Google Calendar.",
    icon: "calendar",
    status: "skeleton",
    auth: {
      type: "oauth2-pkce",
      ...GOOGLE_AUTH,
      scopes: ["https://www.googleapis.com/auth/calendar.events"],
    },
    settings: [clientIdSetting],
    actions: [
      {
        name: "list_events",
        description: "List events between two times (ISO 8601). Defaults to the next 7 days.",
        inputSchema: objectSchema({
          from: { type: "string", format: "date-time" },
          to: { type: "string", format: "date-time" },
        }),
        effects: { readOnly: true },
        summarize: (i) => `List events${str(i.from) ? ` from ${str(i.from)}` : ""}`,
        async run(input, ctx) {
          const from = str(input.from) || new Date(ctx.clock.now()).toISOString();
          const to = str(input.to) || new Date(Date.parse(from) + 7 * 86_400_000).toISOString();
          const r = await apiJson(
            ctx,
            self,
            `${BASE}?singleEvents=true&orderBy=startTime&timeMin=${encodeURIComponent(from)}&timeMax=${encodeURIComponent(to)}`,
          );
          const items = (r.items as Array<{ summary?: string; start?: { dateTime?: string; date?: string } }>) ?? [];
          return items.length
            ? items.map((e) => `${e.start?.dateTime ?? e.start?.date ?? ""}  ${e.summary ?? "(no title)"}`).join("\n")
            : "No events.";
        },
      },
      {
        name: "create_event",
        description: "Book an event. Times are ISO 8601.",
        inputSchema: objectSchema(
          {
            title: { type: "string", minLength: 1 },
            start: { type: "string", format: "date-time" },
            end: { type: "string", format: "date-time" },
            attendees: { type: "array", items: { type: "string", format: "email" } },
            description: { type: "string" },
          },
          ["title", "start", "end"],
        ),
        effects: { books: true },
        verb: "Book",
        fields: {
          title: { label: "Title" },
          start: { label: "Starts" },
          end: { label: "Ends" },
          attendees: { label: "Guests" },
        },
        summarize: (i, ctx) => {
          const start = Date.parse(str(i.start));
          const when = Number.isNaN(start) ? str(i.start) : formatLocal(start, ctx.timeZone, ctx.locale);
          const guests = strList(i.attendees);
          return `"${clip(str(i.title), 40)}" on ${when}${guests.length ? ` with ${guests.join(", ")}` : ""}`;
        },
        async run(input, ctx) {
          const r = await apiJson(ctx, self, `${BASE}?sendUpdates=all`, {
            method: "POST",
            json: {
              summary: str(input.title),
              description: str(input.description) || undefined,
              start: { dateTime: str(input.start) },
              end: { dateTime: str(input.end) },
              attendees: strList(input.attendees).map((email) => ({ email })),
            },
          });
          return `Booked: ${str(r.htmlLink)}`;
        },
      },
    ],
  };
}
