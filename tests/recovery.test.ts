import { describe, expect, it, vi } from "vitest";
import type { LlmProvider } from "../src/core/types.js";
import { ResultHistory } from "../src/app/history.js";
import { VoiceSession, type SessionDeps, type VoiceResult } from "../src/app/session.js";
import { MemoryInjector } from "../src/providers/injectors.js";
import { dictate } from "../src/modes/dictation.js";
import { captureMacTarget, MacInjector } from "../src/app/macos.js";
import { HotkeyController } from "../src/app/hotkeys.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
function setup(overrides: Partial<SessionDeps> = {}) {
  let target: string | undefined = "document-a";
  let clock = 0;
  const injector = new MemoryInjector("original", "original");
  const results: VoiceResult[] = [];
  const deps: SessionDeps = {
    recorder: { start: async () => {}, stop: async () => "recording.wav", cancel: async () => {} },
    stt: { transcribe: async () => "make it better" }, injector,
    llm: { complete: async () => ({ text: "rewritten", toolCalls: [] }) },
    tools: async () => ({ list: async () => [], call: async () => "" }),
    status: vi.fn(), confirm: async () => true, captureTarget: async () => target,
    result: entry => results.push(entry), now: () => clock, ...overrides,
  };
  const session = new VoiceSession(deps);
  async function start(mode: "dictate" | "edit" = "dictate") {
    session.press(mode);
    // Wait for destination/selection capture and recorder acknowledgement.
    await session["starting"];
    clock += 1000;
  }
  return { session, deps, injector, results, start, focus: (next?: string) => { target = next; } };
}

describe("destination and recovery", () => {
  it("retains output without pasting after focus changes during transcription", async () => {
    const transcript = deferred<string>();
    const t = setup({ stt: { transcribe: () => transcript.promise } });
    await t.start();
    const release = t.session.release();
    t.focus("document-b"); transcript.resolve("hello"); await release;
    expect(t.injector.text).toBe("original");
    expect(t.results[0]).toMatchObject({ text: "Hello.", status: "ready" });
  });

  it("fails closed if accessibility cannot identify the destination", async () => {
    const t = setup(); t.focus(undefined); await t.start(); await t.session.release();
    expect(t.injector.text).toBe("original");
    expect(t.results[0]?.error).toContain("destination changed");
  });

  it("captures edit selection before transcription and refuses a changed selection", async () => {
    const t = setup(); await t.start("edit");
    t.injector.selection = "different"; await t.session.release();
    expect(t.injector.text).toBe("original");
    expect(t.results[0]).toMatchObject({ text: "rewritten", status: "ready" });
    expect(t.results[0]?.error).toContain("selection changed");
  });

  it("previews edits and leaves the original untouched on rejection", async () => {
    const preview = vi.fn(async () => false);
    const t = setup({ previewEdit: preview }); await t.start("edit"); await t.session.release();
    expect(preview).toHaveBeenCalledWith("original", "rewritten", expect.any(AbortSignal));
    expect(t.injector.text).toBe("original");
    expect(t.results[0]?.status).toBe("ready");
  });

  it("validates the restored destination after an edit approval", async () => {
    const t = setup({ previewEdit: async () => true, restoreTarget: async () => { t.focus("wrong-window"); } });
    await t.start("edit"); await t.session.release();
    expect(t.injector.text).toBe("original");
    expect(t.results[0]?.status).toBe("ready");
  });

  it("cancels processing without inserting a late model result", async () => {
    const response = deferred<{ text: string; toolCalls: [] }>();
    const started = deferred<AbortSignal>();
    const llm: LlmProvider = { complete: request => { started.resolve(request.signal!); return response.promise; } };
    const t = setup({ llm, cleanupMode: "polished" }); await t.start();
    const release = t.session.release(); const signal = await started.promise;
    await t.session.cancel(); expect(signal.aborted).toBe(true);
    response.resolve({ text: "late result", toolCalls: [] }); await release;
    expect(t.injector.text).toBe("original"); expect(t.session.busy).toBe(false);
    expect(t.results[0]?.status).toBe("cancelled");
  });

  it("reinserts into a newly chosen target only after the hotkey is released", async () => {
    const t = setup();
    t.session.queueInsertion("recovered text"); t.focus("new-destination");
    t.session.press("dictate"); await t.session["starting"];
    expect(t.injector.text).toBe("original");
    await t.session.release(); expect(t.injector.text).toBe("originalrecovered text");
  });

  it("invalidates scratch-that after unrelated input", async () => {
    const t = setup(); await t.start(); await t.session.release();
    const inserted = t.injector.text;
    t.session.invalidateUndo(); t.deps.stt.transcribe = async () => "scratch that";
    await t.start(); await t.session.release(); expect(t.injector.text).toBe(inserted);
  });

  it("does not record voice commands as failed results", async () => {
    const t = setup(); await t.start(); await t.session.release();
    t.deps.stt.transcribe = async () => "select all";
    await t.start(); await t.session.release();
    expect(t.injector.selection).toBe("originalMake it better.");
    expect(t.results.map(entry => entry.status)).toEqual(["inserted"]);
  });

  it("stops a microphone that finished starting after the request was cancelled", async () => {
    const started = deferred<void>();
    const recorder = { start: vi.fn(() => started.promise), stop: vi.fn(async () => "recording.wav"), cancel: vi.fn(async () => {}) };
    const t = setup({ recorder });
    t.session.press("dictate");
    const release = t.session.release();
    await t.session.cancel();
    started.resolve(); await release;
    expect(recorder.cancel).toHaveBeenCalledOnce();
    expect(recorder.stop).not.toHaveBeenCalled();
    expect(t.session.busy).toBe(false);
  });

  it("Escape cancels even when no recording hotkey is held", () => {
    const cancel = vi.fn();
    const controller = new HotkeyController({ dictate: "AltRight", edit: "MetaRight", agent: "CtrlRight" }, { press: vi.fn(), release: vi.fn(), cancel });
    controller.handle({ type: "down", key: "Escape" }); expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("dictation preferences", () => {
  it("preserves fillers, repetition, casing, and punctuation in verbatim mode", async () => {
    const injector = new MemoryInjector();
    await dictate("um the the URL is example.com/path", injector, {}, { mode: "verbatim" });
    expect(injector.text).toBe("um the the URL is example.com/path");
  });

  it("matches vocabulary literally at word boundaries, longest first, without cascades", async () => {
    const injector = new MemoryInjector();
    await dictate("open ai c++ cat concatenate", injector, {}, { mode: "verbatim", vocabulary: { "open ai": "OpenAI", "c++": "C++", cat: "dog", dog: "wolf" } });
    expect(injector.text).toBe("OpenAI C++ dog concatenate");
  });
});

describe("bounded local history", () => {
  const entry = (id: string): VoiceResult => ({ id, at: 0, mode: "dictate", transcript: id, text: id, status: "inserted" });
  it("keeps only the latest result with history disabled", () => {
    const history = new ResultHistory(); history.add(entry("a")); history.add(entry("b"));
    expect(history.list().map(item => item.id)).toEqual(["b"]);
  });
  it("bounds enabled history, prunes immediately on opt-out, and clears", () => {
    const history = new ResultHistory(true, 2); ["a", "b", "c"].forEach(id => history.add(entry(id)));
    expect(history.list().map(item => item.id)).toEqual(["c", "b"]);
    history.configure(false, 2); expect(history.list()).toHaveLength(1);
    history.clear(); expect(history.list()).toEqual([]);
  });
});


describe("macOS accessibility capture", () => {
  it("reads a selection without synthetic clipboard keystrokes", async () => {
    const exec = vi.fn(async () => "selected text\n\n");
    const selection = await new MacInjector(exec, 0, true).getSelection();
    expect(selection).toBe("selected text\n");
    expect(exec).toHaveBeenCalledOnce();
    expect(exec.mock.calls[0]).toEqual(["osascript", expect.any(Array)]);
  });
  it("returns no target on inaccessible or malformed accessibility output", async () => {
    expect(await captureMacTarget(async () => "not a target")).toBeUndefined();
    expect(await captureMacTarget(async () => { throw new Error("denied"); })).toBeUndefined();
    expect(JSON.parse((await captureMacTarget(async () => "123\nwindow|field"))!)).toEqual({ pid: 123, snapshot: "window|field" });
  });
});
