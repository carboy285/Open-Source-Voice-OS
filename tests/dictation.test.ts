import { describe, expect, it } from "vitest";
import { cleanTranscript } from "../src/modes/dictation.js";

describe("cleanTranscript", () => {
  it("removes fillers and stutters, capitalizes and ends the sentence", () => {
    expect(cleanTranscript("um so the the meeting is uh at noon")).toBe("So the meeting is at noon.");
  });

  it("converts spoken punctuation only when enabled", () => {
    expect(cleanTranscript("hello comma world", { spokenPunctuation: true })).toBe("Hello, world.");
    expect(cleanTranscript("the comma key")).toBe("The comma key.");
  });
});
