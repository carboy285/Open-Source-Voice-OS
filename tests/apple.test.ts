import { describe, expect, it } from "vitest";
import { appleConnectors, type NativeCall } from "../src/connectors/apple.js";
import { ConnectorRegistry, MemoryRegistryState } from "../src/connectors/registry.js";
import { classify } from "../src/gate/classify.js";
import { context } from "./fakes/connectors.js";

const NOW = Date.UTC(2026, 9, 18, 15, 0);

function setup(reply: unknown = {}) {
  const calls: Array<{ service: string; action: string; args: Record<string, unknown> }> = [];
  const native: NativeCall = async (service, action, args) => {
    calls.push({ service, action, args });
    return typeof reply === "function" ? (reply as (a: string) => unknown)(action) : reply;
  };
  const ctx = context({}, { clock: { now: () => NOW }, timeZone: "UTC", locale: "en-US" });
  const registry = new ConnectorRegistry(
    new MemoryRegistryState(new Set(["apple_mail", "apple_calendar", "apple_reminders", "apple_notes"])),
    () => ctx,
  ).register(...appleConnectors(native));
  return { calls, registry };
}

describe("Apple connectors", () => {
  it("stay off until the user turns them on", async () => {
    const registry = new ConnectorRegistry(new MemoryRegistryState(), () => context()).register(
      ...appleConnectors(async () => ({})),
    );
    expect(await registry.list()).toEqual([]);
    expect(registry.catalog().map((c) => c.id)).toEqual([
      "apple_mail",
      "apple_calendar",
      "apple_reminders",
      "apple_notes",
    ]);
  });

  it("read mail, calendar and reminders without asking, and gate every change", async () => {
    const { registry } = setup();
    const gated = Object.fromEntries((await registry.list()).map((s) => [s.name, classify(s).gated]));
    expect(gated).toMatchObject({
      "apple_mail.recent": false,
      "apple_mail.read": false,
      "apple_mail.draft": true,
      "apple_calendar.events": false,
      "apple_calendar.create_event": true,
      "apple_reminders.list": false,
      "apple_reminders.lists": false,
      "apple_reminders.create": true,
      "apple_reminders.complete": true,
      "apple_notes.create": true,
    });
    // There is no send action at all.
    expect(Object.keys(gated).some((n) => /send/.test(n))).toBe(false);
  });

  it("saves a note through the Mac app after approval, with the user's text untouched", async () => {
    const { registry, calls } = setup({ ok: true });
    const out = await registry.call("apple_notes.create", { title: "Trip <ideas>", body: "Lisbon\n& Porto" });
    expect(out).toBe('Saved the note "Trip <ideas>" in Notes.');
    expect(calls).toEqual([
      { service: "notes", action: "create", args: { title: "Trip <ideas>", body: "Lisbon\n& Porto" } },
    ]);
  });

  it("needs a title for a note and describes it in the approval", async () => {
    const { registry } = setup({ ok: true });
    const spec = (await registry.list()).find((s) => s.name === "apple_notes.create")!;
    expect(spec.inputSchema).toMatchObject({ required: ["title"] });
    await expect(registry.call("apple_notes.create", { body: "no title" })).rejects.toThrow();
  });

  it("lists recent mail from what the Mac app returns", async () => {
    const { registry, calls } = setup({
      items: [{ id: "41", sender: "Ana <ana@example.com>", subject: "Lunch?", dateMs: NOW - 3_600_000, read: false }],
    });
    const out = await registry.call("apple_mail.recent", { limit: 5, unread_only: true, contains: "lunch" });
    expect(out).toContain("41: [unread] Ana <ana@example.com>: Lunch?");
    expect(calls[0]).toEqual({
      service: "mail",
      action: "recent",
      args: { limit: 5, unreadOnly: true, query: "lunch" },
    });
  });

  it("lists events from today for a week by default", async () => {
    const { registry, calls } = setup({
      items: [
        { title: "Dentist", startMs: NOW + 3_600_000, endMs: NOW + 7_200_000, calendar: "Home", location: "Main St" },
      ],
    });
    const out = await registry.call("apple_calendar.events", {});
    expect(out).toContain("Dentist at Main St [Home]");
    expect(calls[0]?.args).toMatchObject({ fromMs: Date.UTC(2026, 9, 18), toMs: Date.UTC(2026, 9, 25) });
  });

  it("creates an event with a one-hour default and rejects a time it can't read", async () => {
    const { registry, calls } = setup();
    await registry.call("apple_calendar.create_event", { title: "Lunch", start: "2026-10-19T12:00:00Z" });
    expect(calls[0]?.args).toMatchObject({ startMs: Date.UTC(2026, 9, 19, 12), endMs: Date.UTC(2026, 9, 19, 13) });
    await expect(registry.call("apple_calendar.create_event", { title: "x", start: "someday" })).rejects.toThrow(
      /understand/,
    );
  });

  it("reads a message and cuts a very long body", async () => {
    const { registry } = setup({ sender: "a@b.c", subject: "Hi", dateMs: NOW, body: "x".repeat(9000) });
    const out = await registry.call("apple_mail.read", { id: "41" });
    expect(out).toContain("Subject: Hi");
    expect(out.length).toBeLessThan(6200);
  });
});
