import { describe, expect, it } from "vitest";
import { applyVocabulary, Vocabulary } from "../src/core/vocabulary.js";
import { cleanTranscript, dictate } from "../src/modes/dictation.js";
import { MemoryInjector } from "../src/providers/injectors.js";

describe("custom vocabulary", () => {
  it("preserves preferred spelling after cleanup", () => {
    expect(cleanTranscript("um eye oh ess uses git hub", {
      vocabulary: { "eye oh ess": "iOS", "git hub": "GitHub" },
    })).toBe("iOS uses GitHub.");
  });

  it("matches whole phrases with Unicode boundaries and prefers longer aliases", () => {
    expect(applyVocabulary("voice os, voice, invoice, café, décafé", {
      voice: "sound", "voice os": "Voice OS", café: "coffee",
    })).toBe("Voice OS, sound, invoice, coffee, décafé");
    expect(applyVocabulary("ſound", { sound: "voice" })).toBe("voice");
  });

  it("treats regex characters and replacement dollars literally, without cascading", () => {
    expect(applyVocabulary("c++ and cash", { "c++": "cash", cash: "$&" })).toBe("cash and $&");
  });

  it("applies vocabulary once, after model polish", async () => {
    const injector = new MemoryInjector();
    await dictate("git hub", injector, {}, {
      vocabulary: { "git hub": "GitHub", GitHub: "should not cascade" },
      polish: { complete: async () => ({ text: "I use git hub.", toolCalls: [] }) },
    });
    expect(injector.text).toBe("I use GitHub.");
  });

  it("rejects empty aliases, non-string replacements, and case-insensitive duplicates", () => {
    expect(() => Vocabulary.parse({ " ": "bad" })).toThrow();
    expect(() => Vocabulary.parse({ test: 42 })).toThrow();
    expect(() => Vocabulary.parse({ GitHub: "a", github: "b" })).toThrow();
    expect(Vocabulary.parse({ " git hub ": " GitHub " })).toEqual({ "git hub": "GitHub" });
  });
});
