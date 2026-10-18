import Anthropic from "@anthropic-ai/sdk";
import type { LlmProvider, LlmRequest, LlmResponse, Message, ToolCall } from "../core/types.js";
import { WireNames } from "./wire-names.js";

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";

export interface AnthropicLlmOptions {
  apiKey: string;
  /** Any model id the user's key can use. */
  model?: string;
  baseURL?: string;
  client?: Pick<Anthropic, "messages">;
}

/** Claude through the official SDK, with the user's own key. */
export class AnthropicLlm implements LlmProvider {
  readonly model: string;
  private readonly client: Pick<Anthropic, "messages">;

  constructor(options: AnthropicLlmOptions) {
    this.model = options.model?.trim() || DEFAULT_ANTHROPIC_MODEL;
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey, baseURL: options.baseURL });
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const names = new WireNames();
    const tools: Anthropic.Tool[] | undefined = request.tools?.map((t) => ({
      name: names.wire(t.name),
      description: t.description.slice(0, 1024),
      input_schema: { type: "object", ...t.inputSchema } as Anthropic.Tool.InputSchema,
    }));
    const response = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: Math.max(request.maxTokens ?? 4096, 4096),
        system: request.system,
        messages: toAnthropic(request.messages, names),
        ...(tools?.length ? { tools } : {}),
      },
      { signal: request.signal },
    );
    if (response.stop_reason === "refusal") {
      return { text: "The model declined this request.", toolCalls: [], raw: response.content };
    }
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const toolCalls: ToolCall[] = response.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: names.unwire(b.name), input: (b.input ?? {}) as Record<string, unknown> }));
    return { text, toolCalls, raw: response.content };
  }
}

export function toAnthropic(messages: Message[], names: WireNames): Anthropic.MessageParam[] {
  return messages.map((m): Anthropic.MessageParam => {
    if (m.role === "user") return { role: "user", content: m.text };
    if (m.role === "tool") {
      return {
        role: "user",
        content: m.results.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.id,
          content: r.content,
          ...(r.isError ? { is_error: true } : {}),
        })),
      };
    }
    // Replay the provider's own content unchanged. Wire names are deterministic for the same tool list.
    if (Array.isArray(m.raw)) return { role: "assistant", content: m.raw as Anthropic.ContentBlockParam[] };
    const content: Anthropic.ContentBlockParam[] = [];
    if (m.text) content.push({ type: "text", text: m.text });
    for (const call of m.toolCalls) {
      content.push({ type: "tool_use", id: call.id, name: names.wire(call.name), input: call.input });
    }
    return { role: "assistant", content };
  });
}
