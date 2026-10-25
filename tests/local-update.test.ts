import { afterEach, describe, expect, it, vi } from "vitest";
import { MurmurCore, type CoreEvent, type ShellBridge } from "../src/core/app.js";
import type { LlmProvider } from "../src/core/types.js";
import { MemorySecretStore } from "../src/secrets/store.js";
import { ScriptedApprovalUi } from "./fakes/approval.js";

const cores: MurmurCore[] = [];
afterEach(async () => {
  await Promise.all(cores.splice(0).map((core) => core.close()));
});
function setup(bridge: Partial<ShellBridge> = {}, llm?: LlmProvider) {
  const events: CoreEvent[] = [];
  const insert = vi.fn(async () => ({ ok: true, method: "test" }));
  const core = new MurmurCore({
    databasePath: ":memory:",
    mcpConfigPath: "/nonexistent/mcp.json",
    llm,
    bridge: {
      insertText: insert,
      captureContext: async () => ({ appId: "mail", selection: "original text" }),
      secrets: new MemorySecretStore(),
      approvals: new ScriptedApprovalUi([]),
      emit: (event) => events.push(event),
      ...bridge,
    },
  });
  cores.push(core);
  return { core, insert, events };
}

describe("local Murmur improvements", () => {
  it("preserves verbatim wording while applying the existing dictionary", async () => {
    const t = setup();
    t.core.settings.set("dictation.cleanupMode", "verbatim");
    t.core.dictionary.add({ written: "OpenAI", spoken: ["open ai"] });
    const result = await t.core.finishDictation({ transcript: "um the the open ai URL is example.com/path" });
    expect(result.text).toBe("um the the OpenAI URL is example.com/path");
    expect(t.insert).toHaveBeenCalledWith(result.text, { guardTarget: true });
  });
  it("skips model polish in Clean up mode", async () => {
    const complete = vi.fn(async () => ({ text: "rewritten", toolCalls: [] }));
    const t = setup({}, { complete });
    t.core.settings.set("dictation.cleanupMode", "clean");
    const result = await t.core.finishDictation({ transcript: "um hello there" });
    expect(result.text).toBe("Hello there.");
    expect(complete).not.toHaveBeenCalled();
  });
  it("rejects invalid cleanup preferences", () => {
    const t = setup();
    expect(() => t.core.settings.set("dictation.cleanupMode", "invalid")).toThrow();
    expect(() => t.core.settings.set("recovery.limit", 1000)).toThrow();
  });
  it("retains failed insertion output and explains a changed destination accurately", async () => {
    const t = setup({ insertText: async () => ({ ok: false, method: "none", reason: "target_changed" }) });
    await t.core.finishDictation({ transcript: "hello there" });
    expect(t.events).toContainEqual(
      expect.objectContaining({ type: "recovery.result", text: "Hello there.", status: "ready" }),
    );
    expect(t.events).toContainEqual(
      expect.objectContaining({
        type: "state",
        state: "error",
        message: expect.stringContaining("destination changed"),
      }),
    );
    expect(t.core.settings.get("history.saveTranscripts")).toBe(false);
    expect(t.core.history.list(1)[0]?.transcript).toBeNull();
  });
  it("blocks late model output after cancellation and leaves a recoverable transcript", async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let reply!: (value: { text: string; toolCalls: [] }) => void;
    const response = new Promise<{ text: string; toolCalls: [] }>((resolve) => {
      reply = resolve;
    });
    let signal: AbortSignal | undefined;
    const t = setup(
      {},
      {
        complete: (request) => {
          signal = request.signal;
          entered();
          return response;
        },
      },
    );
    t.core.beginDictation();
    const job = t.core.finishDictation({ transcript: "hello there" });
    await started;
    t.core.cancelDictation();
    await job;
    reply({ text: "late output", toolCalls: [] });
    expect(signal?.aborted).toBe(true);
    expect(t.insert).not.toHaveBeenCalled();
    expect(t.events).toContainEqual(
      expect.objectContaining({ type: "recovery.result", transcript: "hello there", status: "cancelled" }),
    );
  });
  it("previews an edit against the original selection and preserves it when declined", async () => {
    let selection = "original text";
    const preview = vi.fn(async () => false);
    const t = setup(
      { captureContext: async () => ({ selection }), previewEdit: preview },
      { complete: async () => ({ text: "new text", toolCalls: [] }) },
    );
    t.core.beginDictation();
    selection = "different text";
    await t.core.runEdit({ transcript: "shorten this" });
    expect(preview).toHaveBeenCalledWith("original text", "new text");
    expect(t.insert).not.toHaveBeenCalled();
    expect(t.events).toContainEqual(
      expect.objectContaining({ type: "recovery.result", mode: "edit", text: "new text", status: "ready" }),
    );
  });
  it("rechecks the native destination for an approved edit", async () => {
    const t = setup({ previewEdit: async () => true }, { complete: async () => ({ text: "new text", toolCalls: [] }) });
    t.core.beginDictation();
    await t.core.runEdit({ transcript: "shorten this" });
    expect(t.insert).toHaveBeenCalledWith("new text", { guardTarget: true });
  });
  it("cancels an edit while its preview is awaiting a decision", async () => {
    let ready!: () => void;
    const shown = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const t = setup(
      {
        previewEdit: () => {
          ready();
          return new Promise(() => {});
        },
      },
      { complete: async () => ({ text: "new text", toolCalls: [] }) },
    );
    t.core.beginDictation();
    const job = t.core.runEdit({ transcript: "shorten this" });
    await shown;
    t.core.cancelDictation();
    await job;
    expect(t.insert).not.toHaveBeenCalled();
    expect(t.events).toContainEqual(
      expect.objectContaining({ type: "recovery.result", mode: "edit", status: "cancelled" }),
    );
  });
});
