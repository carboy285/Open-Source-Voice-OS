import { describe, expect, it } from "vitest";
import type { NativeCall } from "../src/connectors/apple.js";
import { computerConnector } from "../src/connectors/computer.js";
import { ConnectorRegistry, MemoryRegistryState } from "../src/connectors/registry.js";
import type { ToolSpec } from "../src/core/types.js";
import { ApprovalGate } from "../src/gate/gate.js";
import { parseApprovalMode, potentiallyUnsafe, type ApprovalMode } from "../src/gate/safety.js";
import { runAgent } from "../src/modes/agent.js";
import { context } from "./fakes/connectors.js";
import { ScriptedApprovalUi } from "./fakes/approval.js";
import { callsThenReply, ScriptedLlm, toolCall } from "./fakes/llm.js";
import { bookEvent, deleteFile, RecordingToolHost, renameFile, sendEmail } from "./fakes/tools.js";

const rename = toolCall("r", "files.rename", { path: "/tmp/a.txt", newName: "b.txt" });
const send = toolCall("s", "gmail.send", { to: ["ana@example.com"], subject: "Hi", body: "Hello" });
const del = toolCall("d", "files.delete", { path: "/tmp/a.txt" });

async function run(
  mode: ApprovalMode | undefined,
  calls = [rename, send, del],
  answers: "approve" | "cancel" = "approve",
) {
  const ui = new ScriptedApprovalUi(
    // One extra answer each: a delete asks twice (review, then confirm).
    [...calls, ...calls].map(() => ({ decision: answers === "approve" ? "approve" : "cancel" }) as never),
  );
  const host = new RecordingToolHost([sendEmail, bookEvent, renameFile, deleteFile]);
  const gate = new ApprovalGate(ui, { mode: mode ? () => mode : undefined });
  const outcome = await runAgent("go", new ScriptedLlm(callsThenReply(calls)), host, gate);
  return { ui, host, outcome };
}

describe("approval modes", () => {
  it("asks about every gated action by default, and when the setting is not a known mode", async () => {
    for (const mode of [undefined, "ask" as const]) {
      const { ui, host } = await run(mode);
      // Deleting asks twice: once to review and once to confirm.
      expect(ui.shown.map((p) => p.tool)).toEqual(["files.rename", "gmail.send", "files.delete", "files.delete"]);
      expect(host.calls).toHaveLength(3);
    }
    expect(parseApprovalMode("everything")).toBe("ask");
    expect(parseApprovalMode(undefined)).toBe("ask");
    expect(parseApprovalMode(true)).toBe("ask");
    expect(parseApprovalMode("full")).toBe("full");
    expect(parseApprovalMode("auto")).toBe("auto");
  });

  it("Approve for me runs routine things and still asks about sending and deleting", async () => {
    const { ui, host, outcome } = await run("auto", [rename, send, del], "cancel");
    expect(ui.shown.map((p) => p.tool)).toEqual(["gmail.send", "files.delete"]);
    expect(host.calls.map((c) => c.name)).toEqual(["files.rename"]);
    expect(outcome.trace.map((s) => s.approval)).toEqual(["auto", "cancelled", "cancelled"]);
  });

  it("Approve for me asks when an event would invite other people", async () => {
    const alone = toolCall("a", "calendar.create_event", { title: "Focus", start: "2026-10-19T15:00:00Z" });
    const withGuests = toolCall("g", "calendar.create_event", {
      title: "Sync",
      start: "2026-10-19T15:00:00Z",
      attendees: ["ana@example.com"],
    });
    const { ui, host } = await run("auto", [alone, withGuests], "cancel");
    expect(ui.shown.map((p) => p.raw.title)).toEqual(["Sync"]);
    expect(host.calls).toHaveLength(1);
  });

  it("Full access asks about nothing", async () => {
    const { ui, host, outcome } = await run("full");
    expect(ui.shown).toHaveLength(0);
    expect(host.calls.map((c) => c.name)).toEqual(["files.rename", "gmail.send", "files.delete"]);
    expect(outcome.trace.every((s) => s.approval === "auto")).toBe(true);
  });

  it("reads the mode again for each action, so a change in Settings applies to the next one", async () => {
    let mode: ApprovalMode = "full";
    const ui = new ScriptedApprovalUi([{ decision: "cancel" }]);
    const host = new RecordingToolHost([sendEmail, renameFile]);
    const gate = new ApprovalGate(ui, { mode: () => mode });
    const llm = new ScriptedLlm([
      { text: "", toolCalls: [rename] },
      { text: "", toolCalls: [send] },
      { text: "ok", toolCalls: [] },
    ]);
    const original = host.call.bind(host);
    host.call = async (name, input) => {
      mode = "ask";
      return original(name, input);
    };
    await runAgent("go", llm, host, gate);
    expect(host.calls.map((c) => c.name)).toEqual(["files.rename"]);
    expect(ui.shown.map((p) => p.tool)).toEqual(["gmail.send"]);
  });
});

describe("what still asks in Approve for me", () => {
  const mac: NativeCall = async () => ({});
  const registry = new ConnectorRegistry(new MemoryRegistryState(new Set(["computer"])), () => context()).register(
    computerConnector({ native: mac, platform: "darwin", exists: () => true }),
  );
  const spec = async (name: string): Promise<ToolSpec> => (await registry.list()).find((s) => s.name === name)!;

  it("lets routine computer actions through", async () => {
    expect(potentiallyUnsafe(await spec("computer.open"), { target: "/Users/sam/a.pdf" })).toBe(false);
    expect(potentiallyUnsafe(await spec("computer.open_app"), { app: "Notes" })).toBe(false);
    expect(potentiallyUnsafe(await spec("computer.quit_app"), { app: "Notes" })).toBe(false);
    expect(potentiallyUnsafe(await spec("computer.type"), { app: "Notes", text: "milk, eggs" })).toBe(false);
    expect(potentiallyUnsafe(await spec("computer.press_keys"), { app: "Notes", keys: "cmd+s" })).toBe(false);
    expect(potentiallyUnsafe(await spec("computer.choose_menu"), { app: "Notes", path: ["File", "New Note"] })).toBe(
      false,
    );
  });

  it("asks for keys and menu items that send or delete, and for typing a new line", async () => {
    for (const keys of ["return", "enter", "cmd+backspace", "cmd+q", "cmd+w", "delete"]) {
      expect(potentiallyUnsafe(await spec("computer.press_keys"), { app: "Mail", keys }), keys).toBe(true);
    }
    expect(
      potentiallyUnsafe(await spec("computer.choose_menu"), { app: "Finder", path: ["Finder", "Empty Trash"] }),
    ).toBe(true);
    expect(potentiallyUnsafe(await spec("computer.choose_menu"), { app: "Mail", path: ["Message", "Send"] })).toBe(
      true,
    );
    expect(potentiallyUnsafe(await spec("computer.type"), { app: "Messages", text: "hi\n" })).toBe(true);
  });

  it("asks for a click it cannot describe from the screen, since it cannot judge it", async () => {
    expect(potentiallyUnsafe(await spec("computer.click"), { id: "e1" })).toBe(true);
  });

  it("keeps asking for tools it cannot judge and for starting other programs", () => {
    const mcp: ToolSpec = {
      name: "thing.run",
      description: "",
      inputSchema: { type: "object", properties: {} },
      origin: "mcp",
      effects: { modifies: true },
    };
    expect(potentiallyUnsafe(mcp, {})).toBe(true);
    const start: ToolSpec = { ...mcp, name: "agents.start", origin: "builtin" };
    expect(potentiallyUnsafe(start, { agent: "codex" })).toBe(true);
  });
});
