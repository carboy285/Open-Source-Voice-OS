import { describe, expect, it } from "vitest";
import type { LlmProvider } from "../src/core/types.js";
import { dictate } from "../src/modes/dictation.js";
import { editSelection } from "../src/modes/edit.js";
import { toApiMessages } from "../src/providers/anthropic.js";
import { MemoryInjector } from "../src/providers/injectors.js";

const reply = (text: string): LlmProvider => ({ complete: async () => ({ text, toolCalls: [] }) });

describe("dictate", () => {
  it("inserts cleaned text, optionally polished by a model", async () => {
    const plain = new MemoryInjector();
    await dictate("um hello there", plain);
    expect(plain.text).toBe("Hello there.");
    const polished = new MemoryInjector();
    await dictate("um hello there", polished, { appName: "Mail" }, { polish: reply("Hello there,") });
    expect(polished.text).toBe("Hello there,");
  });

  it("inserts nothing for an empty transcript", async () => {
    const injector = new MemoryInjector();
    expect(await dictate("um uh", injector)).toBe("");
    expect(injector.text).toBe("");
  });
});

describe("editSelection", () => {
  it("replaces the selection and refuses an empty one", async () => {
    const injector = new MemoryInjector("Say hello world now", "hello world");
    await editSelection("shorter", injector, reply("hi"));
    expect(injector.text).toBe("Say hi now");
    await expect(editSelection("x", new MemoryInjector("a", ""), reply("b"))).rejects.toThrow(/Nothing is selected/);
  });
});

describe("toApiMessages", () => {
  it("maps tool turns to tool_use and tool_result blocks", () => {
    const mapped = toApiMessages([
      { role: "assistant", text: "", toolCalls: [{ id: "1", name: "t", input: { a: 1 } }] },
      { role: "tool", results: [{ id: "1", content: "r", isError: true }] },
    ]);
    expect(mapped[0]).toEqual({ role: "assistant", content: [{ type: "tool_use", id: "1", name: "t", input: { a: 1 } }] });
    expect(mapped[1]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "1", content: "r", is_error: true }],
    });
  });
});
