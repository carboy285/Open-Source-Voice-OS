import type { LlmProvider, LlmRequest, LlmResponse, ToolCall } from "../../src/core/types.js";

/** Replies from a script, one response per call. Records every request. */
export class ScriptedLlm implements LlmProvider {
  readonly requests: LlmRequest[] = [];
  constructor(private readonly script: Array<LlmResponse | ((req: LlmRequest) => LlmResponse)>) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push({ ...request, messages: structuredClone(request.messages), signal: undefined });
    const next = this.script.shift() ?? { text: "Done.", toolCalls: [] };
    return typeof next === "function" ? next(request) : next;
  }
}

export const toolCall = (id: string, name: string, input: Record<string, unknown>): ToolCall => ({ id, name, input });
export const callsThenReply = (calls: ToolCall[], reply = "Done."): LlmResponse[] => [
  { text: "", toolCalls: calls },
  { text: reply, toolCalls: [] },
];

/** Always asks for another tool call. */
export class LoopingLlm implements LlmProvider {
  calls = 0;
  async complete(): Promise<LlmResponse> {
    this.calls++;
    return { text: "", toolCalls: [toolCall(`c${this.calls}`, "files.search", { query: `q${this.calls}` })] };
  }
}
