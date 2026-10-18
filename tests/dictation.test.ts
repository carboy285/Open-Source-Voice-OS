import { describe, expect, it } from "vitest";
import { cleanTranscript, cleanup } from "../src/dictation/cleanup.js";
import { applyDictionary, buildVariants, vocabularyHint, type DictionaryEntry } from "../src/dictation/dictionary.js";
import { CorrectionLearner, MemoryCorrectionStore } from "../src/dictation/learning.js";
import { formatLists } from "../src/dictation/lists.js";
import { diffWords, polish, rejectReason } from "../src/dictation/polish.js";
import { categorize } from "../src/dictation/tone.js";
import { processDictation } from "../src/modes/dictation.js";
import { ScriptedLlm } from "./fakes/llm.js";

let nextId = 1;
const entry = (written: string, spoken: string[] = [], extra: Partial<DictionaryEntry> = {}): DictionaryEntry => ({
  id: nextId++,
  written,
  spoken,
  kind: "term",
  caseSensitive: false,
  source: "manual",
  uses: 0,
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});

describe("cleanTranscript", () => {
  it("removes fillers and stutters, capitalizes and ends the sentence", () => {
    expect(cleanTranscript("um so the the meeting is uh at noon")).toBe("So the meeting is at noon.");
  });

  it("converts spoken punctuation only when enabled", () => {
    expect(cleanTranscript("hello comma world", { spokenPunctuation: true })).toBe("Hello, world.");
    expect(cleanTranscript("the comma key")).toBe("The comma key.");
  });
});

describe("change report", () => {
  it("reports each stage's changes by category", () => {
    const { text, changes } = cleanup("um the the cooper netties cluster is uh ready", {
      dictionary: [entry("Kubernetes", ["cooper netties"])],
    });
    expect(text).toBe("The Kubernetes cluster is ready.");
    expect(changes.filter((c) => c.category === "filler_removed").map((c) => c.before)).toEqual([
      "um",
      "uh",
      "the the",
    ]);
    expect(changes).toContainEqual({ category: "dictionary_applied", before: "cooper netties", after: "Kubernetes" });
    expect(changes.some((c) => c.category === "formatting")).toBe(true);
  });

  it("removes 'you know' and 'I mean' only as fillers", () => {
    expect(cleanTranscript("it was, you know, fine")).toBe("It was, fine.");
    expect(cleanTranscript("do you know the time")).toBe("Do you know the time.");
    expect(cleanTranscript("I mean it")).toBe("I mean it.");
  });

  it("returns nothing for an empty transcript", () => {
    expect(cleanup("  um uh  ").text).toBe("");
  });
});

describe("dictionary", () => {
  it("prefers the longest match and uses the written form exactly", () => {
    const entries = [entry("Postgres", ["postgres"]), entry("PostgreSQL", ["postgres q l", "postgres sequel"])];
    expect(applyDictionary("we use postgres sequel and postgres", entries).text).toBe("we use PostgreSQL and Postgres");
  });

  it("matches whole words only", () => {
    expect(applyDictionary("the ai is said to be fair", [entry("AI", ["ai"])]).text).toBe("the AI is said to be fair");
  });

  it("never applies inside URLs, emails or code spans", () => {
    const entries = [entry("Murmur", ["murmur"])];
    const text = "see https://murmur.dev/murmur or mail murmur@example.com and run `murmur add` with murmur";
    expect(applyDictionary(text, entries).text).toBe(
      "see https://murmur.dev/murmur or mail murmur@example.com and run `murmur add` with Murmur",
    );
  });

  it("matches a case-sensitive acronym only in its own case", () => {
    const entries = [entry("IT", ["eye tea"], { caseSensitive: true, kind: "acronym" })];
    expect(applyDictionary("it is eye tea work", entries).text).toBe("it is IT work");
  });

  it("resolves conflicts to the most recently updated entry", () => {
    const old = entry("Jon", ["john"], { updatedAt: 1 });
    const recent = entry("Johnny", ["john"], { updatedAt: 2 });
    const { conflicts } = buildVariants([old, recent]);
    expect(conflicts).toEqual(["john"]);
    expect(applyDictionary("ask john", [old, recent]).text).toBe("ask Johnny");
  });

  it("builds a vocabulary hint with the most-used entries first", () => {
    expect(vocabularyHint([entry("Rare", [], { uses: 1 }), entry("Common", [], { uses: 9 })])).toBe("Common, Rare");
  });
});

describe("list formatting", () => {
  it("formats first/second/third as a numbered list", () => {
    expect(cleanTranscript("my goals are first ship the beta second fix the login bug and third write docs")).toBe(
      "My goals are:\n1. Ship the beta\n2. Fix the login bug\n3. Write docs",
    );
  });

  it("formats bullets", () => {
    expect(formatLists("Groceries bullet milk bullet eggs bullet bread.")).toBe("Groceries:\n- Milk\n- Eggs\n- Bread");
  });

  it("formats clause-initial cardinals but leaves prose alone", () => {
    expect(formatLists("One, call Ana. Two, book the room.")).toBe("1. Call Ana\n2. Book the room");
    expect(formatLists("I have one dog and two cats.")).toBe("I have one dog and two cats.");
  });

  it("needs at least two items", () => {
    expect(formatLists("First we eat.")).toBe("First we eat.");
  });
});

describe("tone", () => {
  it("maps apps and browser tabs to categories", () => {
    expect(categorize({ appId: "com.tinyspeck.slackmacgap" })).toBe("chat");
    expect(categorize({ appId: "OUTLOOK.EXE" })).toBe("email");
    expect(categorize({ appId: "com.google.Chrome", windowTitle: "Inbox (3) - Gmail" })).toBe("email");
    expect(categorize({ appId: "com.jetbrains.intellij" })).toBe("code");
    expect(categorize({ appId: "com.example.unknown" })).toBe("general");
    expect(categorize({ appId: "com.example.unknown" }, { "com.example.unknown": "notes" })).toBe("notes");
  });

  it("drops the trailing period on a one-sentence chat message", () => {
    expect(cleanTranscript("sounds good see you then", { category: "chat" })).toBe("Sounds good see you then");
    expect(cleanTranscript("sounds good. see you then", { category: "chat" })).toBe("Sounds good. See you then.");
  });

  it("keeps code verbatim: no capitalization, no added period, no spoken punctuation", () => {
    expect(cleanTranscript("git commit dash m fix comma", { category: "code", spokenPunctuation: true })).toBe(
      "git commit dash m fix comma",
    );
  });

  it("uses full sentences for email and documents", () => {
    expect(cleanTranscript("thanks for the update", { category: "email" })).toBe("Thanks for the update.");
  });

  it("skips polish for code and passes style rules otherwise", async () => {
    const llm = new ScriptedLlm([{ text: "Thanks for the update.", toolCalls: [] }]);
    await processDictation("print hello", { appId: "com.microsoft.VSCode" }, { polish: llm });
    expect(llm.requests).toHaveLength(0);
    await processDictation("thanks for the update", { appId: "com.apple.mail" }, { polish: llm });
    expect(llm.requests[0]!.messages[0]).toMatchObject({ text: expect.stringMatching(/greeting or sign-off/) });
  });
});

describe("Japanese", () => {
  it("removes Japanese fillers and ends with 。 without adding spaces", () => {
    const { text, changes } = cleanup("えーと、明日の会議は あの、三時からです", { language: "ja" });
    expect(text).toBe("明日の会議は三時からです。");
    expect(changes.filter((c) => c.category === "filler_removed").map((c) => c.before)).toEqual(["えーと", "あの"]);
  });

  it("keeps あの when it means 'that'", () => {
    expect(cleanTranscript("あの人に連絡します")).toBe("あの人に連絡します。");
  });

  it("does not add a second sentence mark", () => {
    expect(cleanTranscript("了解です！")).toBe("了解です！");
  });
});

describe("polish guard", () => {
  it("rejects a result whose length changed by more than 40%", () => {
    expect(rejectReason("Meet at noon.", "Meet at noon. Also, here is a summary of the whole plan.")).toBe("length");
    expect(rejectReason("Meet at noon.", "Meet at 12.")).toBeUndefined();
  });

  it("rejects a translated result", () => {
    expect(rejectReason("明日の会議は三時からです。", "The meeting is at three.")).toBe("language");
    expect(rejectReason("I will send the report to the team on Monday", "Enviaré el informe al equipo el lunes")).toBe(
      "language",
    );
  });

  it("keeps the stage-5 text and logs polish_rejected", async () => {
    const llm = new ScriptedLlm([
      { text: "Sure! Here is a much longer answer to your question about lunch.", toolCalls: [] },
    ]);
    const result = await polish("What about lunch?", llm);
    expect(result.text).toBe("What about lunch?");
    expect(result.changes[0]?.category).toBe("polish_rejected");
  });

  it("falls back when the model is too slow", async () => {
    const slow = { complete: () => new Promise<never>(() => {}) };
    const result = await polish("Meet at noon.", slow, { timeoutMs: 10 });
    expect(result).toEqual({ text: "Meet at noon.", changes: [] });
  });

  it("reports spelling and grammar fixes from a word diff", () => {
    const changes = diffWords("I recieve the the report", "I receive the report");
    expect(changes).toContainEqual({ category: "spelling_fixed", before: "recieve", after: "receive" });
    expect(changes.some((c) => c.category === "grammar_fixed")).toBe(true);
  });
});

describe("dictionary learning", () => {
  it("suggests an entry after the same correction twice in 7 days", () => {
    let now = 0;
    const learner = new CorrectionLearner(new MemoryCorrectionStore(), () => false, { now: () => now });
    expect(learner.observe("kubernetties", "Kubernetes")).toBeUndefined();
    now += 3 * 24 * 3600 * 1000;
    expect(learner.observe("kubernetties", "Kubernetes")?.change).toEqual({
      category: "dictionary_added",
      before: "kubernetties",
      after: "Kubernetes",
    });
  });

  it("forgets corrections older than 7 days", () => {
    let now = 0;
    const learner = new CorrectionLearner(new MemoryCorrectionStore(), () => false, { now: () => now });
    learner.observe("ana", "Anna");
    now += 8 * 24 * 3600 * 1000;
    expect(learner.observe("ana", "Anna")).toBeUndefined();
  });

  it("does nothing when learning is off", () => {
    const learner = new CorrectionLearner(new MemoryCorrectionStore());
    learner.enabled = false;
    learner.observe("a", "b");
    expect(learner.observe("a", "b")).toBeUndefined();
  });
});
