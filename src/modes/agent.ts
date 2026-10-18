import type { AppContext, ConfirmHandler, LlmProvider, Message, ToolHost, ToolResult } from "../core/types.js";

const AGENT_SYSTEM = `You are a voice assistant that operates the user's computer through tools. The user's request is a spoken transcript and may contain recognition errors. Use tools when the request needs them, prefer the fewest calls, and answer briefly in plain spoken language. Never claim an action succeeded unless a tool result confirms it.`;

export interface AgentOptions {
  maxSteps?: number;
  context?: AppContext;
}

export interface AgentOutcome {
  reply: string;
  steps: number;
}

/**
 * Runs the tool-use loop. Tools not marked read-only go through `confirm` first;
 * a refusal is reported to the model so it can adapt instead of retrying silently.
 */
export async function runAgent(
  request: string,
  llm: LlmProvider,
  tools: ToolHost,
  confirm: ConfirmHandler,
  options: AgentOptions = {},
): Promise<AgentOutcome> {
  const specs = await tools.list();
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  const maxSteps = options.maxSteps ?? 8;
  const ctx = options.context;
  const contextLines = [
    ctx?.appName ? `Frontmost app: ${ctx.appName}` : "",
    ctx?.screenText ? `Text on screen:\n${ctx.screenText}` : "",
  ].filter(Boolean);
  const messages: Message[] = [{ role: "user", text: [...contextLines, `Request: ${request}`].join("\n\n") }];

  for (let step = 1; step <= maxSteps; step++) {
    const response = await llm.complete({ system: AGENT_SYSTEM, messages, tools: specs, maxTokens: 1024 });
    messages.push({ role: "assistant", text: response.text, toolCalls: response.toolCalls });
    if (response.toolCalls.length === 0) return { reply: response.text.trim(), steps: step };

    const results: ToolResult[] = [];
    for (const call of response.toolCalls) {
      const spec = byName.get(call.name);
      if (!spec) {
        results.push({ id: call.id, content: `Unknown tool: ${call.name}`, isError: true });
        continue;
      }
      if (!spec.readOnly && !(await confirm({ tool: call.name, input: call.input }))) {
        results.push({ id: call.id, content: "The user declined this action.", isError: true });
        continue;
      }
      try {
        results.push({ id: call.id, content: await tools.call(call.name, call.input) });
      } catch (error) {
        results.push({ id: call.id, content: error instanceof Error ? error.message : String(error), isError: true });
      }
    }
    messages.push({ role: "tool", results });
  }
  return { reply: "I stopped because the task needed too many steps.", steps: maxSteps };
}
