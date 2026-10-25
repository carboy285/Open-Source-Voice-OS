import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MurmurCore } from "../src/core/app.js";
import type { LlmProvider, LlmRequest } from "../src/core/types.js";
import { extractFacts, parseMemoryCommand } from "../src/memory/extract.js";
import { DEFAULT_SOUL, MemoryStore, looksSensitive } from "../src/memory/store.js";
import { MemorySecretStore } from "../src/secrets/store.js";
import { ScriptedApprovalUi } from "./fakes/approval.js";
import { ScriptedLlm } from "./fakes/llm.js";

const dirs: string[] = [];
const cores: MurmurCore[] = [];
afterEach(async () => {
  await Promise.all(cores.splice(0).map((core) => core.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "murmur-memory-test-"));
  dirs.push(dir);
  return dir;
}

function store(options: { maxEntries?: () => number; injectFacts?: () => number } = {}) {
  const dir = tempDir();
  let now = Date.UTC(2026, 9, 24, 12);
  const memory = new MemoryStore({
    dir,
    clock: { now: () => now },
    ...options,
  });
  return { memory, dir, advance: (days: number) => (now += days * 86_400_000) };
}

describe("MemoryStore", () => {
  it("creates SOUL.md and MEMORY.md once, readable only by the user", () => {
    const { memory, dir } = store();
    memory.ensure();
    expect(readFileSync(join(dir, "SOUL.md"), "utf8")).toBe(DEFAULT_SOUL);
    expect(readFileSync(join(dir, "MEMORY.md"), "utf8")).toContain("# Memory");
    expect(statSync(join(dir, "MEMORY.md")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "SOUL.md")).mode & 0o777).toBe(0o600);

    // A second run must not overwrite what the user edited.
    memory.setSoul("# Mine");
    memory.ensure();
    expect(memory.soul()).toBe("# Mine");
  });

  it("writes facts under a heading with the day they were learned", () => {
    const { memory, dir } = store();
    memory.remember([
      { text: "Ana is the user's sister.", kind: "person" },
      { text: "Prefers short answers.", kind: "preference" },
      { text: "Ships Murmur, a dictation app.", kind: "project" },
    ]);
    const written = readFileSync(join(dir, "MEMORY.md"), "utf8");
    expect(written).toContain("## People\n\n- Ana is the user's sister. (2026-10-24)");
    expect(written).toContain("## Preferences");
    expect(written).toContain("## Projects");
    expect(memory.count()).toBe(3);
  });

  it("does not store the same fact twice, even with different punctuation or case", () => {
    const { memory } = store();
    expect(memory.remember([{ text: "Lives in Berlin." }])).toHaveLength(1);
    expect(memory.remember([{ text: "lives in berlin" }])).toEqual([]);
    expect(memory.count()).toBe(1);
  });

  it("replaces the fact a new one supersedes", () => {
    const { memory } = store();
    memory.remember([{ text: "Lives in Berlin.", kind: "person" }]);
    memory.remember([{ text: "Lives in Lisbon.", kind: "person", supersedes: "Lives in Berlin." }]);
    expect(memory.facts().map((fact) => fact.text)).toEqual(["Lives in Lisbon."]);
  });

  it("never keeps secrets, even when asked directly", () => {
    const { memory } = store();
    expect(memory.remember([{ text: "My password is hunter2" }])).toEqual([]);
    expect(memory.remember([{ text: "The API key is sk-1234" }])).toEqual([]);
    expect(memory.count()).toBe(0);
    expect(looksSensitive("recovery code")).toBe(true);
  });

  it("forgets by phrase or id", () => {
    const { memory } = store();
    const [fact] = memory.remember([{ text: "Lives in Berlin.", kind: "person" }]);
    memory.remember([{ text: "Prefers dark mode.", kind: "preference" }]);
    expect(memory.forget("berlin")).toBe(1);
    expect(memory.facts().map((item) => item.text)).toEqual(["Prefers dark mode."]);
    expect(memory.forget(fact!.id)).toBe(0);
    expect(memory.forget("dark")).toBe(1);
    expect(memory.count()).toBe(0);
  });

  it("clears facts but keeps SOUL.md, and can replace the whole file", () => {
    const { memory } = store();
    memory.remember([{ text: "Lives in Berlin." }]);
    memory.clear();
    expect(memory.facts()).toEqual([]);
    expect(memory.soul()).toBe(DEFAULT_SOUL);

    memory.replace("# Memory\n\n## People\n\n- Jo is a friend. (2026-01-02)");
    expect(memory.facts()).toEqual([
      { id: expect.any(String), kind: "person", text: "Jo is a friend.", date: "2026-01-02" },
    ]);
  });

  it("reads edits made by hand, ignoring prose and dates", () => {
    const { memory } = store();
    memory.ensure();
    writeFileSync(
      join(memory.memoryPath),
      "# Memory\n\n> a note to myself\n\n## Preferences\n\n- Likes tea (2025-03-04)\n- Hates meetings\n\nNo heading after this\n",
    );
    expect(memory.facts().map(({ kind, text, date }) => ({ kind, text, date }))).toEqual([
      { kind: "preference", text: "Likes tea", date: "2025-03-04" },
      { kind: "preference", text: "Hates meetings", date: "2026-10-24" },
      { kind: "preference", text: "No heading after this", date: "2026-10-24" },
    ]);
  });

  it("searches on words, ranking exact matches first", () => {
    const { memory } = store();
    memory.remember([
      { text: "Ana is the user's sister.", kind: "person" },
      { text: "Ana prefers morning meetings.", kind: "preference" },
      { text: "Works on the Murmur project.", kind: "project" },
    ]);
    expect(memory.search("ana").map((fact) => fact.text)).toEqual([
      "Ana prefers morning meetings.",
      "Ana is the user's sister.",
    ]);
    expect(memory.search("murmur")).toHaveLength(1);
    expect(memory.search("").length).toBe(3);
  });

  it("builds a prompt block with the soul and the facts", () => {
    const { memory } = store({ injectFacts: () => 2 });
    memory.remember([
      { text: "Prefers short answers.", kind: "preference" },
      { text: "Ana is the user's sister.", kind: "person" },
      { text: "Works on Murmur.", kind: "project" },
    ]);
    const block = memory.prompt();
    expect(block).toContain("<about_you>");
    expect(block).toContain("You are Murmur");
    expect(block).toContain("<memory>");
    expect(block).toContain("Facts this user asked you to remember");
    // The cap is respected and preferences come first.
    expect(block.match(/^- \[/gm)).toHaveLength(2);
    expect(block).toContain("Prefers short answers.");
    expect(block).toContain("Ana is the user's sister.");
    expect(memory.prompt("murmur")).toContain("Works on Murmur.");
  });

  it("keeps standing preferences in a prompt even when the request matches something else", () => {
    const { memory } = store({ injectFacts: () => 3 });
    memory.remember([
      { text: "Prefers short answers.", kind: "preference" },
      { text: "Works on Murmur.", kind: "project" },
    ]);
    const block = memory.prompt("what is on my calendar");
    expect(block).toContain("Prefers short answers.");
    expect(block).toContain("Works on Murmur.");
  });

  it("answers recall from the file, grouped like the file", () => {
    const { memory } = store();
    memory.remember([
      { text: "Ana is the user's sister.", kind: "person" },
      { text: "Prefers short answers.", kind: "preference" },
    ]);
    expect(memory.recall()).toBe("People:\n- Ana is the user's sister.\n\nPreferences:\n- Prefers short answers.");
    expect(memory.recall("ana")).toContain("Ana is the user's sister.");
  });

  it("bounds the file by dropping the least valuable facts first", () => {
    const { memory } = store({ maxEntries: () => 10 });
    memory.remember([{ text: "Prefers tea.", kind: "preference" }]);
    for (let i = 0; i < 12; i++) memory.remember([{ text: `Miscellaneous note number ${i}.`, kind: "other" }]);
    expect(memory.count()).toBe(10);
    expect(memory.facts()).toContainEqual(expect.objectContaining({ text: "Prefers tea." }));
  });

  it("guesses a category for facts written without a model", () => {
    const { memory } = store();
    memory.remember([
      { text: "Prefers brief replies." },
      { text: "We decided to ship on Friday." },
      { text: "My wife is Ana." },
      { text: "Building a dictation app." },
    ]);
    expect(
      memory
        .facts()
        .map((fact) => fact.kind)
        .sort(),
    ).toEqual(["decision", "person", "preference", "project"]);
  });

  it("removes both files when all data is deleted", () => {
    const { memory } = store();
    memory.ensure();
    memory.destroy();
    expect(memory.facts()).toEqual([]);
    expect(() => readFileSync(memory.memoryPath, "utf8")).toThrow();
  });
});

describe("memory commands", () => {
  it("recognises explicit remember, forget and recall requests", () => {
    expect(parseMemoryCommand("remember that I prefer short answers")).toEqual({
      kind: "remember",
      text: "I prefer short answers",
    });
    expect(parseMemoryCommand("Remember: my wife is Ana.")).toEqual({ kind: "remember", text: "my wife is Ana" });
    expect(parseMemoryCommand("forget that I live in Berlin")).toEqual({
      kind: "forget",
      query: "I live in Berlin",
    });
    expect(parseMemoryCommand("what do you remember?")).toEqual({ kind: "recall" });
    expect(parseMemoryCommand("what do you know about Ana?")).toEqual({ kind: "recall", query: "Ana" });
    expect(parseMemoryCommand("do you remember my sister?")).toEqual({ kind: "recall", query: "my sister" });
  });

  it("leaves ordinary requests to the agent", () => {
    expect(parseMemoryCommand("remember to call Ana at five")).toBeUndefined();
    expect(parseMemoryCommand("note the meeting is at noon")).toBeUndefined();
    expect(parseMemoryCommand("remind me to stretch")).toBeUndefined();
    expect(parseMemoryCommand("forget it")).toBeUndefined();
    expect(parseMemoryCommand("remember that my password is hunter2")).toBeUndefined();
  });
});

describe("fact extraction", () => {
  const llm = (text: string): LlmProvider & { requests: LlmRequest[] } => {
    const requests: LlmRequest[] = [];
    return {
      requests,
      async complete(request) {
        requests.push(request);
        return { text, toolCalls: [] };
      },
    };
  };

  it("keeps valid facts and drops duplicates, secrets and noise", async () => {
    const provider = llm(
      JSON.stringify({
        facts: [
          { text: "Ana is the user's sister.", kind: "person" },
          { text: "ana is the user's sister", kind: "person" },
          { text: "Prefers short answers.", kind: "preference" },
          { text: "My password is hunter2", kind: "other" },
        ],
      }),
    );
    expect(await extractFacts(provider, "my sister Ana", "Noted.")).toEqual([
      { text: "Ana is the user's sister.", kind: "person" },
      { text: "Prefers short answers.", kind: "preference" },
    ]);
    expect(provider.requests[0]!.system).toContain("Return JSON only");
  });

  it("reads JSON wrapped in a fence or prose", async () => {
    const fenced = llm('```json\n{"facts":[{"text":"Lives in Lisbon.","kind":"person"}]}\n```');
    expect(await extractFacts(fenced, "I moved", "Nice.")).toEqual([{ text: "Lives in Lisbon.", kind: "person" }]);
    const prose = llm('Here is what I kept: {"facts":[{"text":"Ships Murmur.","kind":"project"}]} — done.');
    expect(await extractFacts(prose, "I ship Murmur", "Great.")).toEqual([{ text: "Ships Murmur.", kind: "project" }]);
  });

  it("returns nothing for malformed output instead of guessing", async () => {
    expect(await extractFacts(llm("I think the user likes tea."), "I like tea", "Noted.")).toEqual([]);
    expect(await extractFacts(llm('{"facts":[{"text":"x"}]}'), "hi", "hello")).toEqual([]);
    expect(await extractFacts(llm('{"facts":[]}'), "", "hello")).toEqual([]);
  });
});

function core(llm?: LlmProvider) {
  const c = new MurmurCore({
    databasePath: ":memory:",
    mcpConfigPath: "/nonexistent/mcp.json",
    llm,
    bridge: {
      captureContext: async () => ({}),
      insertText: async () => ({ ok: true, method: "test" }),
      secrets: new MemorySecretStore(),
      approvals: new ScriptedApprovalUi([]),
      emit: () => {},
    },
  });
  cores.push(c);
  return c;
}

const replyTo = (c: MurmurCore, taskId: string) => c.tasks.get(taskId)?.reply;

describe("memory in the core", () => {
  it("answers remember and recall without the model", async () => {
    const llm = new ScriptedLlm([]);
    const c = core(llm);

    const first = await c.startTask({ transcript: "remember that I prefer short answers" });
    expect(replyTo(c, first.taskId)).toBe("I'll remember that.");
    expect(llm.requests).toHaveLength(0);

    const again = await c.startTask({ transcript: "Remember that I prefer short answers." });
    expect(replyTo(c, again.taskId)).toBe("I already remember that.");

    const recall = await c.startTask({ transcript: "what do you remember?" });
    expect(replyTo(c, recall.taskId)).toContain("I prefer short answers");
    expect(llm.requests).toHaveLength(0);
  });

  it("forgets a fact by phrase and says when there is nothing to forget", async () => {
    const c = core();
    await c.startTask({ transcript: "remember that my sister is Ana" });
    const forgotten = await c.startTask({ transcript: "forget that my sister is Ana" });
    expect(replyTo(c, forgotten.taskId)).toBe("Removed from memory: 1.");
    expect(c.memoryStatus().facts).toEqual([]);

    const missing = await c.startTask({ transcript: "forget about the moon" });
    expect(replyTo(c, missing.taskId)).toBe("I couldn't find that in memory.");
  });

  it("says memory is off instead of quietly writing", async () => {
    const c = core();
    c.settings.set("memory.enabled", false);
    const task = await c.startTask({ transcript: "remember that I prefer tea" });
    expect(replyTo(c, task.taskId)).toBe("Memory is turned off in Settings › Personalize.");
    expect(c.memory.facts()).toEqual([]);
  });

  it("learns from a finished turn in the background", async () => {
    const llm = new ScriptedLlm([
      { text: '{"facts":[{"text":"Ana is the user\'s sister.","kind":"person"}]}', toolCalls: [] },
    ]);
    const c = core(llm);
    expect(await c.learnNow("my sister Ana helps me", "Good to know.")).toEqual([
      { id: expect.any(String), kind: "person", text: "Ana is the user's sister.", date: expect.any(String) },
    ]);
    expect(c.memoryStatus().facts).toHaveLength(1);
  });

  it("does not learn when automatic memory is switched off", async () => {
    const llm = new ScriptedLlm([{ text: '{"facts":[{"text":"Ana is my sister.","kind":"person"}]}', toolCalls: [] }]);
    const c = core(llm);
    c.settings.set("memory.autoRemember", false);
    expect(await c.learnNow("my sister Ana", "Noted.")).toEqual([]);
    expect(llm.requests).toHaveLength(0);
  });

  it("shows both files and the parsed facts to Settings", async () => {
    const c = core();
    await c.startTask({ transcript: "remember that I work on Murmur" });
    const status = c.memoryStatus();
    expect(status.enabled).toBe(true);
    expect(status.autoRemember).toBe(true);
    expect(status.soul).toContain("You are Murmur");
    expect(status.memory).toContain("- I work on Murmur");
    expect(status.facts).toHaveLength(1);
    expect(status.path.endsWith("MEMORY.md")).toBe(true);
  });
});
