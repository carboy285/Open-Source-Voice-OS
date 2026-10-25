import { describe, expect, it } from "vitest";
import type { LlmProvider, LlmResponse, ToolHost } from "../src/core/types.js";
import { runAgent } from "../src/modes/agent.js";

function scripted(...responses: LlmResponse[]): LlmProvider & { seen: number } {
  const queue = [...responses];
  return {
    seen: 0,
    async complete() {
      this.seen++;
      return queue.shift() ?? { text: "end", toolCalls: [] };
    },
  };
}

function host(calls: string[]): ToolHost {
  return {
    list: async () => [
      { name: "read", description: "", inputSchema: {}, readOnly: true },
      { name: "write", description: "", inputSchema: {}, readOnly: false },
    ],
    call: async (name) => {
      calls.push(name);
      return `${name} ok`;
    },
  };
}

describe("runAgent", () => {
  it("runs read-only tools without asking", async () => {
    const calls: string[] = [];
    const llm = scripted({ text: "", toolCalls: [{ id: "1", name: "read", input: {} }] }, { text: "done", toolCalls: [] });
    const outcome = await runAgent("go", llm, host(calls), async () => {
      throw new Error("must not be asked");
    });
    expect(calls).toEqual(["read"]);
    expect(outcome).toEqual({ reply: "done", steps: 2 });
  });

  it("asks before side-effecting tools and respects a refusal", async () => {
    const calls: string[] = [];
    const llm = scripted({ text: "", toolCalls: [{ id: "1", name: "write", input: { a: 1 } }] }, { text: "ok, skipped", toolCalls: [] });
    const asked: string[] = [];
    const outcome = await runAgent("go", llm, host(calls), async ({ tool }) => {
      asked.push(tool);
      return false;
    });
    expect(asked).toEqual(["write"]);
    expect(calls).toEqual([]);
    expect(outcome.reply).toBe("ok, skipped");
  });

  it("does not dispatch an approved tool if cancellation arrived during approval", async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    const llm = scripted({ text: "", toolCalls: [{ id: "1", name: "write", input: {} }] });
    await expect(runAgent("go", llm, host(calls), async () => {
      controller.abort(); return true;
    }, { signal: controller.signal })).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("stops after maxSteps", async () => {
    const loop: LlmResponse = { text: "", toolCalls: [{ id: "1", name: "read", input: {} }] };
    const outcome = await runAgent("go", scripted(loop, loop, loop), host([]), async () => true, { maxSteps: 2 });
    expect(outcome.steps).toBe(2);
    expect(outcome.reply).toMatch(/too many steps/);
  });
});
