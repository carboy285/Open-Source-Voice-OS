import { describe, expect, it } from "vitest";
import { parseSnippetFlags, resolveUtterance } from "../src/modes/commands.js";

const snippets = {
  "my address": "1 Infinite Loop\nCupertino, CA",
  "sign off": "Best,\nSam",
};

describe("resolveUtterance", () => {
  it("leaves ordinary dictation alone", () => {
    expect(resolveUtterance("remind me to call Ana")).toEqual({ kind: "text", text: "remind me to call Ana" });
  });

  it("matches a snippet by its whole trigger, ignoring case, punctuation and spacing", () => {
    const expected = { kind: "snippet", trigger: "my address", text: snippets["my address"] };
    expect(resolveUtterance("My address.", { snippets })).toEqual(expected);
    expect(resolveUtterance("  my   address  ", { snippets })).toEqual(expected);
  });

  it("accepts “insert <trigger>” as shorthand", () => {
    expect(resolveUtterance("insert my address", { snippets })).toEqual({
      kind: "snippet",
      trigger: "my address",
      text: snippets["my address"],
    });
  });

  it("matches editing commands", () => {
    expect(resolveUtterance("Scratch that.")).toEqual({ kind: "command", command: "undo" });
    expect(resolveUtterance("undo that")).toEqual({ kind: "command", command: "undo" });
    expect(resolveUtterance("select all")).toEqual({ kind: "command", command: "selectAll" });
  });

  it("ignores filler words when matching", () => {
    expect(resolveUtterance("um, scratch that")).toEqual({ kind: "command", command: "undo" });
    expect(resolveUtterance("select all, you know")).toEqual({ kind: "command", command: "selectAll" });
  });

  it("never fires inside a longer sentence", () => {
    expect(resolveUtterance("select all the rows and delete them")).toEqual({
      kind: "text",
      text: "select all the rows and delete them",
    });
    expect(resolveUtterance("insert my address into the form", { snippets })).toEqual({
      kind: "text",
      text: "insert my address into the form",
    });
  });

  it("lets a command win over a snippet with the same trigger", () => {
    expect(resolveUtterance("select all", { snippets: { "select all": "oops" } })).toEqual({
      kind: "command",
      command: "selectAll",
    });
  });

  it("can leave commands as dictation", () => {
    expect(resolveUtterance("select all", { commands: false })).toEqual({ kind: "text", text: "select all" });
  });

  it("returns text for an empty or blank transcript", () => {
    expect(resolveUtterance("")).toEqual({ kind: "text", text: "" });
    expect(resolveUtterance("   ")).toEqual({ kind: "text", text: "   " });
  });

  it("ignores blank snippet triggers", () => {
    expect(resolveUtterance("hello", { snippets: { "  ": "x" } })).toEqual({ kind: "text", text: "hello" });
  });
});

describe("parseSnippetFlags", () => {
  it("parses repeated trigger=text flags, keeping later equals signs in the text", () => {
    expect(parseSnippetFlags(["my address=1 Infinite Loop", "sign off=a = b"])).toEqual({
      "my address": "1 Infinite Loop",
      "sign off": "a = b",
    });
  });

  it("rejects malformed flags", () => {
    expect(() => parseSnippetFlags(["no separator"])).toThrow(/trigger=text/);
    expect(() => parseSnippetFlags(["=text"])).toThrow(/trigger=text/);
    expect(() => parseSnippetFlags(["trigger="])).toThrow(/non-empty/);
  });

  it("returns nothing when no flags were passed", () => {
    expect(parseSnippetFlags(undefined)).toEqual({});
  });
});
