import { describe, expect, it } from "vitest";
import { MurmurCore, type CoreEvent } from "../src/core/app.js";
import { MemorySecretStore } from "../src/secrets/store.js";
import { ScriptedApprovalUi } from "./fakes/approval.js";

function core(insertText: () => Promise<{ ok: boolean; method: string; reason?: string }>) {
  const events: CoreEvent[] = [];
  const c = new MurmurCore({
    databasePath: ":memory:",
    mcpConfigPath: "/nonexistent/mcp.json",
    bridge: {
      insertText,
      captureContext: async () => ({}),
      secrets: new MemorySecretStore(),
      approvals: new ScriptedApprovalUi([]),
      emit: (e) => events.push(e),
    },
  });
  return { c, events };
}

describe("a dictation that could not be placed", () => {
  for (const [name, insertText] of [
    ["ok: false", async () => ({ ok: false, method: "clipboard", reason: "no_post_permission" })],
    ["a rejected request", async () => Promise.reject(new Error("timed out"))],
  ] as const) {
    it(`warns, shows the error in the app and keeps the history row (${name})`, async () => {
      const { c, events } = core(insertText);
      const outcome = await c.finishDictation({ transcript: "um so the meeting is uh at noon" });
      expect(outcome.text).toBe("So the meeting is at noon.");
      const message = "Couldn't paste. Text is on your clipboard. Check Accessibility / Input Monitoring.";
      expect(events).toContainEqual(expect.objectContaining({ type: "notify", kind: "warning", body: message }));
      expect(events).toContainEqual(
        expect.objectContaining({ type: "state", state: "error", step: "inserting", message }),
      );
      expect(events.some((e) => e.type === "state" && e.state === "done")).toBe(false);
      expect(c.history.list(5).length).toBe(1);
    });
  }

  it("ends in done when the text was placed", async () => {
    const { c, events } = core(async () => ({ ok: true, method: "paste" }));
    await c.finishDictation({ transcript: "hello there" });
    expect(events).toContainEqual({ type: "state", state: "done" });
    expect(events.some((e) => e.type === "notify")).toBe(false);
  });
});
