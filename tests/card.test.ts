import { describe, expect, it } from "vitest";
import { buildCard, whenLabel, type CardContext } from "../src/gate/card.js";
import { buildPreview } from "../src/gate/preview.js";
import type { ToolSpec } from "../src/core/types.js";

// Sunday 18 October 2026, 18:42 UTC = 11:42 in Los Angeles.
const ctx: CardContext = { now: Date.UTC(2026, 9, 18, 18, 42), timeZone: "America/Los_Angeles", locale: "en-US" };
const tool = (name: string, icon = "tool", app = "App") => ({ name, icon, app });

describe("whenLabel", () => {
  it("writes the weekday and a shared AM/PM once", () => {
    // Thursday 29 October is more than six days away, so it shows the date as well.
    expect(whenLabel("2026-10-29T14:00:00-07:00", "2026-10-29T14:30:00-07:00", ctx)).toBe(
      "Thu, Oct 29 · 2:00 – 2:30 PM",
    );
    expect(whenLabel("2026-10-22T14:00:00-07:00", "2026-10-22T14:30:00-07:00", ctx)).toBe("Thursday · 2:00 – 2:30 PM");
  });
  it("says Today and Tomorrow, and names a weekday within the week", () => {
    expect(whenLabel("2026-10-18T14:00:00-07:00", "2026-10-18T15:00:00-07:00", ctx)).toBe("Today · 2:00 – 3:00 PM");
    expect(whenLabel("2026-10-19T09:00:00-07:00", undefined, ctx)).toBe("Tomorrow · 9:00 AM");
    expect(
      whenLabel("2026-10-22T14:00:00-07:00", "2026-10-22T14:30:00-07:00", { ...ctx, now: Date.UTC(2026, 9, 20, 18) }),
    ).toBe("Thursday · 2:00 – 2:30 PM");
  });
  it("keeps both AM/PM when they differ, and handles all-day and unreadable values", () => {
    expect(whenLabel("2026-10-19T11:30:00-07:00", "2026-10-19T12:30:00-07:00", ctx)).toBe(
      "Tomorrow · 11:30 AM – 12:30 PM",
    );
    expect(whenLabel("2026-10-19", undefined, ctx)).toBe("Tomorrow · All day");
    expect(whenLabel("whenever", undefined, ctx)).toBeUndefined();
  });
});

describe("buildCard", () => {
  it("draws a calendar event like an event", () => {
    const card = buildCard(
      tool("composio.googlecalendar_create_event", "calendar", "Google Calendar"),
      {
        summary: "Design review with David",
        start_datetime: "2026-10-19T14:00:00-07:00",
        event_duration_minutes: 30,
        attendees: ["david@company.com"],
        create_meeting_room: true,
      },
      "x",
      ctx,
    );
    expect(card.kind).toBe("event");
    expect(card.title).toBe("Design review with David");
    expect(card.rows[0]).toMatchObject({ icon: "clock", values: ["Tomorrow · 2:00 – 2:30 PM"] });
    expect(card.rows[1]).toMatchObject({ icon: "person", style: "chips", values: ["david@company.com"] });
    expect(card.badge).toEqual({ icon: "video", text: "Google Meet" });
  });

  it("draws an email with recipients as chips and a short body", () => {
    const card = buildCard(
      tool("gmail.send", "mail", "Gmail"),
      { to: ["ana@example.com", "bo@example.com"], subject: "Lunch?", body: "Are you free\n\nat noon?" },
      "x",
      ctx,
    );
    expect(card).toMatchObject({ kind: "email", title: "Lunch?" });
    expect(card.rows[0]).toMatchObject({ style: "chips", label: "To", values: ["ana@example.com", "bo@example.com"] });
    expect(card.rows[1]).toMatchObject({ style: "body", values: ["Are you free at noon?"] });
  });

  it("draws a reminder with its time", () => {
    const card = buildCard(
      tool("apple_reminders.create"),
      { title: "Call Mum", due: "2026-10-19T17:00:00-07:00", list: "Home" },
      "x",
      ctx,
    );
    expect(card.kind).toBe("reminder");
    expect(card.rows.map((r) => r.values[0])).toEqual(["Tomorrow · 5:00 PM", "Home"]);
  });

  it("falls back to the summary and the first few values for a tool it does not know", () => {
    const card = buildCard(
      tool("mcp.crm.merge_accounts"),
      { from: "a", into: "b", reason: { nested: true } },
      "Merge account a into b",
      ctx,
    );
    expect(card.kind).toBe("generic");
    expect(card.title).toBe("Merge account a into b");
    expect(card.rows.map((r) => [r.label, r.values[0]])).toEqual([
      ["from", "a"],
      ["into", "b"],
    ]);
  });

  it("never lets a value make the card too big", () => {
    const card = buildCard(
      tool("gmail.send"),
      { to: Array.from({ length: 30 }, (_, i) => `u${i}@x.com`), subject: "s".repeat(500), body: "b".repeat(5000) },
      "x",
      ctx,
    );
    expect(card.title.length).toBeLessThanOrEqual(140);
    expect(card.rows[0]!.values).toHaveLength(8);
    expect(card.rows[1]!.values[0]!.length).toBeLessThanOrEqual(220);
  });
});

describe("preview", () => {
  it("carries the card, and a broken card never breaks the preview", () => {
    const spec: ToolSpec = {
      name: "gmail.send",
      description: "",
      inputSchema: { type: "object", properties: { to: { type: "array" }, subject: { type: "string" } } },
      origin: "builtin",
      effects: { sends: true },
      preview: { summarize: () => "Email to ana", icon: "mail", displayName: "Gmail" },
    };
    const extra = { state: "pending" as const, stage: "review" as const, expiresAt: 0, card: ctx };
    const preview = buildPreview(
      { id: "1", name: spec.name, input: { to: ["a@b.c"], subject: "Hi" } },
      spec,
      { to: ["a@b.c"], subject: "Hi" },
      extra,
    );
    expect(preview.card).toMatchObject({ kind: "email", title: "Hi", app: "Gmail", icon: "mail" });
    expect(preview.fields.length).toBeGreaterThan(0);
    // Hostile input: a cyclic object cannot be turned into a card; the preview still builds.
    const cyclic: Record<string, unknown> = { subject: "x" };
    cyclic.self = cyclic;
    expect(() => buildPreview({ id: "2", name: spec.name, input: cyclic }, spec, cyclic, extra)).not.toThrow();
  });
});
