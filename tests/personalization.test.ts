import { describe, expect, it, vi, afterEach } from "vitest";
import { MurmurCore, type CapturedContext, type CoreEvent } from "../src/core/app.js";
import type { Pcm16Audio, SttProvider } from "../src/core/types.js";
import {
  correctionCommand,
  findShortcut,
  replaceSpokenText,
  selectProfile,
  translateDictation,
  DEFAULT_PROFILES,
} from "../src/dictation/personalization.js";
import { MemorySecretStore } from "../src/secrets/store.js";
import { ScriptedApprovalUi } from "./fakes/approval.js";
import { ScriptedLlm } from "./fakes/llm.js";
import { processDictation } from "../src/modes/dictation.js";

const openCores: MurmurCore[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(openCores.splice(0).map((core) => core.close()));
});
function setup(
  options: {
    llm?: ScriptedLlm;
    stt?: SttProvider;
    context?: CapturedContext;
    placed?: boolean;
    replacementOk?: boolean;
  } = {},
) {
  const inserted: string[] = [],
    replacements: Array<[string, string]> = [],
    events: CoreEvent[] = [];
  let now = 1000;
  const core = new MurmurCore({
    databasePath: ":memory:",
    mcpConfigPath: "/nonexistent/mcp.json",
    llm: options.llm,
    stt: options.stt,
    clock: { now: () => now },
    bridge: {
      captureContext: async () => options.context ?? {},
      insertText: async (text) => {
        inserted.push(text);
        return { ok: options.placed ?? true, method: "test" };
      },
      replaceRecent: async (expected, replacement) => {
        replacements.push([expected, replacement]);
        return { ok: options.replacementOk ?? true };
      },
      secrets: new MemorySecretStore(),
      approvals: new ScriptedApprovalUi([]),
      emit: (event) => events.push(event),
    },
  });
  openCores.push(core);
  return {
    core,
    inserted,
    replacements,
    events,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const speech: Pcm16Audio = {
  sampleRate: 16000,
  pcm: new Uint8Array(
    new Int16Array(Array.from({ length: 16000 }, (_, i) => Math.round(Math.sin(i * 0.15) * 9000))).buffer,
  ),
};

describe("voice shortcuts", () => {
  it("matches only the complete phrase, with speech punctuation and case ignored", () => {
    const shortcuts = [
      { phrase: "My introduction", kind: "text" as const, content: "Hi, I'm Ana.\nNice to meet you." },
    ];
    expect(findShortcut("my introduction!", shortcuts)?.content).toContain("\n");
    expect(findShortcut("please use my introduction", shortcuts)).toBeUndefined();
  });
  it("inserts saved text verbatim without sending it through polish", async () => {
    const llm = new ScriptedLlm([]);
    const s = setup({ llm });
    s.core.settings.set("voice.shortcuts", [
      { phrase: "my intro", kind: "text", content: "Hi — Ana here.\nProduct & design." },
    ]);
    await s.core.finishDictation({ transcript: "My intro." });
    expect(s.inserted).toEqual(["Hi — Ana here.\nProduct & design."]);
    expect(llm.requests).toHaveLength(0);
    expect(s.core.history.list()[0]?.transcript).toBeNull();
  });
  it("rejects duplicate and malformed shortcuts before saving", () => {
    const { core } = setup();
    expect(() =>
      core.settings.set("voice.shortcuts", [
        { phrase: "Test", kind: "text", content: "one" },
        { phrase: "test!", kind: "task", content: "two" },
      ]),
    ).toThrow();
    expect(() => core.settings.set("voice.shortcuts", [{ phrase: "", kind: "text", content: "x" }])).toThrow();
    expect(core.settings.get("voice.shortcuts")).toEqual([]);
  });
  it("routes a task shortcut to the existing task runner without inserting the request", async () => {
    const s = setup({ llm: new ScriptedLlm([{ text: "All set.", toolCalls: [] }]) });
    s.core.settings.set("voice.shortcuts", [{ phrase: "daily wrap up", kind: "task", content: "Summarize my day" }]);
    const start = vi.spyOn(s.core, "startTask").mockResolvedValue({ taskId: "test" });
    await s.core.finishDictation({ transcript: "Daily wrap up." });
    expect(start).toHaveBeenCalledWith({ transcript: "Summarize my day", context: {} });
    expect(s.inserted).toEqual([]);
  });
});

describe("writing profiles", () => {
  it("prefers an app assignment over the selected default and ignores case", () => {
    const profiles = [
      ...DEFAULT_PROFILES,
      { id: "mail", name: "Mail", instructions: "Be brief", appIds: ["OUTLOOK.EXE"] },
    ];
    expect(selectProfile({ appId: "outlook.exe" }, profiles, "friends")?.id).toBe("mail");
    expect(selectProfile({}, profiles, "friends")?.id).toBe("friends");
    expect(selectProfile({}, profiles, "")).toBeUndefined();
  });
  it("adds personal style to polish but preserves code field behavior", async () => {
    const llm = new ScriptedLlm([{ text: "Hello there.", toolCalls: [] }]);
    await processDictation("hello there", {}, { polish: llm, writingInstructions: "Be professional" });
    expect(llm.requests[0]?.messages[0]).toMatchObject({ text: expect.stringContaining("Be professional") });
    await processDictation(
      "git status",
      { appId: "com.microsoft.VSCode" },
      { polish: llm, writingInstructions: "Be professional" },
    );
    expect(llm.requests).toHaveLength(1);
  });
  it("validates profile fields and target languages", () => {
    const { core } = setup();
    expect(() =>
      core.settings.set("writing.profiles", [{ id: "a", name: "", instructions: "x", appIds: [] }]),
    ).toThrow();
    expect(() => core.settings.set("dictation.targetLanguage", "invented")).toThrow();
    expect(() => core.settings.set("dictation.outputMode", "unknown")).toThrow();
  });
});

describe("explicit dictation translation", () => {
  it("translates after cleanup and inserts the translated output", async () => {
    const llm = new ScriptedLlm([
      { text: "Hello there.", toolCalls: [] },
      { text: "こんにちは。", toolCalls: [] },
    ]);
    const s = setup({ llm });
    s.core.settings.set("dictation.outputMode", "translate");
    s.core.settings.set("dictation.targetLanguage", "ja");
    await s.core.finishDictation({ transcript: "um hello there" });
    expect(s.inserted).toEqual(["こんにちは。"]);
    expect(llm.requests[1]?.system).toContain("into ja");
  });
  it("fails visibly without inserting source language when AI is missing", async () => {
    const s = setup();
    s.core.settings.set("dictation.outputMode", "translate");
    await expect(s.core.finishDictation({ transcript: "bonjour" })).rejects.toThrow("AI provider");
    expect(s.inserted).toEqual([]);
  });
  it("rejects empty translation and times out an unresponsive provider", async () => {
    await expect(translateDictation("hello", "es", new ScriptedLlm([{ text: " ", toolCalls: [] }]))).rejects.toThrow(
      "no usable text",
    );
    vi.useFakeTimers();
    const result = expect(translateDictation("hello", "es", { complete: () => new Promise(() => {}) })).rejects.toThrow(
      "timed out",
    );
    await vi.advanceTimersByTimeAsync(15000);
    await result;
  });
  it("never sends a secure field's dictation to an AI provider", async () => {
    const llm = new ScriptedLlm([]);
    const s = setup({ llm, context: { secure: true } });
    await s.core.finishDictation({ transcript: "password" });
    expect(llm.requests).toHaveLength(0);
    expect(s.inserted).toEqual([]);
  });
});

describe("voice corrections", () => {
  it("parses a correction or an explicit dictation undo", () => {
    expect(correctionCommand("change Tuesday to Thursday.")).toEqual({
      kind: "replace",
      from: "Tuesday",
      to: "Thursday",
    });
    expect(correctionCommand("undo my last dictation")).toEqual({ kind: "undo" });
    expect(correctionCommand("undo that")).toBeUndefined();
  });
  it("matches literal phrases at word boundaries and rejects ambiguous replacements", () => {
    expect(replaceSpokenText("Use C++ today.", "C++", "Rust")).toBe("Use Rust today.");
    expect(() => replaceSpokenText("Tuesday and Tuesday.", "Tuesday", "Thursday")).toThrow("exactly once");
    expect(() => replaceSpokenText("Catherine", "Cat", "Dog")).toThrow();
  });
  it("replaces a recent span then undoes that corrected span", async () => {
    const s = setup();
    await s.core.finishDictation({ transcript: "the meeting is Tuesday" });
    await s.core.finishDictation({ transcript: "change Tuesday to Thursday" });
    await s.core.finishDictation({ transcript: "undo my last dictation" });
    expect(s.replacements).toEqual([
      ["The meeting is Tuesday.", "The meeting is Thursday."],
      ["The meeting is Thursday.", ""],
    ]);
    expect(s.inserted).toHaveLength(1);
  });
  it("refuses stale dictation, failed insertion, or a changed field", async () => {
    const s = setup();
    await s.core.finishDictation({ transcript: "Tuesday" });
    s.advance(120001);
    await expect(s.core.finishDictation({ transcript: "undo last dictation" })).rejects.toThrow("No recent");
    const failed = setup({ placed: false });
    await failed.core.finishDictation({ transcript: "Tuesday" });
    await expect(failed.core.finishDictation({ transcript: "undo last dictation" })).rejects.toThrow("No recent");
    const moved = setup({ replacementOk: false });
    await moved.core.finishDictation({ transcript: "Tuesday" });
    await expect(moved.core.finishDictation({ transcript: "undo last dictation" })).rejects.toThrow("cursor has moved");
  });
});

describe("live previews and setup practice", () => {
  it("transcribes locally without insertion, AI calls or history", async () => {
    const llm = new ScriptedLlm([]);
    const s = setup({ llm, stt: { transcribe: async () => ({ text: "preview words" }) } });
    s.core.beginDictation();
    expect(await s.core.previewDictation(speech)).toEqual({ text: "preview words" });
    expect(s.inserted).toEqual([]);
    expect(s.core.history.list()).toEqual([]);
    expect(llm.requests).toEqual([]);
  });
  it("suppresses concurrent preview work and discards results after cancellation", async () => {
    let resolve!: (value: { text: string }) => void;
    const s = setup({
      stt: {
        transcribe: () =>
          new Promise((r) => {
            resolve = r;
          }),
      },
    });
    s.core.beginDictation();
    const pending = s.core.previewDictation(speech);
    expect(await s.core.previewDictation(speech)).toEqual({ text: "" });
    s.core.cancelDictation();
    resolve({ text: "stale" });
    expect(await pending).toEqual({ text: "" });
  });
  it("respects the live preview switch and audio duration limit", async () => {
    const transcribe = vi.fn(async () => ({ text: "test" }));
    const s = setup({ stt: { transcribe } });
    s.core.settings.set("dictation.livePreview", false);
    expect(await s.core.previewDictation(speech)).toEqual({ text: "" });
    s.core.settings.set("dictation.livePreview", true);
    await s.core.previewDictation({ sampleRate: 16000, pcm: new Uint8Array(16000 * 2 * 16) });
    expect(transcribe).not.toHaveBeenCalled();
  });
  it("practice cleans speech without shortcuts, translation, AI, history or insertion", async () => {
    const s = setup();
    s.core.settings.set("dictation.outputMode", "translate");
    s.core.settings.set("voice.shortcuts", [{ phrase: "hello", kind: "task", content: "Do something" }]);
    expect(await s.core.practiceDictation({ transcript: "um hello" })).toEqual({ text: "Hello." });
    expect(s.inserted).toEqual([]);
    expect(s.core.history.list()).toEqual([]);
  });
});

describe("preview cancellation at release", () => {
  it("aborts unfinished preview recognition and transcribes the final recording", async () => {
    let calls = 0;
    let aborted = false;
    const s = setup({
      stt: {
        transcribe: async (_audio, options) => {
          calls++;
          if (calls > 1) return { text: "the complete sentence" };
          return await new Promise((_resolve, reject) =>
            options?.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("cancelled"));
            }),
          );
        },
      },
    });
    s.core.beginDictation();
    const preview = s.core.previewDictation(speech);
    await s.core.finishDictation({ audio: speech });
    expect(aborted).toBe(true);
    expect(await preview).toEqual({ text: "" });
    expect(s.inserted).toEqual(["The complete sentence."]);
  });
  it("keeps task shortcut actions behind the normal approval gate", async () => {
    const llm = new ScriptedLlm([
      {
        text: "",
        toolCalls: [{ id: "r1", name: "reminders.create", input: { text: "Call Ana", when: "in 20 minutes" } }],
      },
      { text: "Cancelled.", toolCalls: [] },
    ]);
    const s = setup({ llm });
    s.core.settings.set("voice.shortcuts", [
      { phrase: "call reminder", kind: "task", content: "Remind me to call Ana in 20 minutes" },
    ]);
    await s.core.finishDictation({ transcript: "Call reminder." });
    await vi.waitFor(() => expect(s.core.runner.list()[0]?.status).toBe("done"));
    expect(s.core.reminders.list()).toEqual([]);
    expect(s.core.runner.list()[0]?.steps[0]?.approval).toBe("cancelled");
    expect(s.events).toContainEqual({ type: "dictation.task" });
  });
});

describe("shortcut input edge cases", () => {
  it("rejects punctuation-only triggers and never matches silence", () => {
    const { core } = setup();
    expect(() =>
      core.settings.set("voice.shortcuts", [{ phrase: "...", kind: "task", content: "do something" }]),
    ).toThrow();
    expect(findShortcut("", [{ phrase: ".", kind: "text", content: "unexpected" }])).toBeUndefined();
  });
  it("preserves intentional indentation in saved text", async () => {
    const s = setup();
    s.core.settings.set("voice.shortcuts", [{ phrase: "my code", kind: "text", content: "  hello\n  world\n" }]);
    await s.core.finishDictation({ transcript: "my code" });
    expect(s.inserted).toEqual(["  hello\n  world\n"]);
  });
});
