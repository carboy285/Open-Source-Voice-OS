import Anthropic from "@anthropic-ai/sdk";
import type { LlmProvider, LlmRequest, LlmResponse, Message, ToolSpec } from "../core/types.js";

export const DEFAULT_MODEL = "claude-sonnet-5-5";

type ApiMessage = Anthropic.MessageParam;

/** Maps provider-neutral messages to Anthropic's wire format. Exported for testing. */
export function toApiMessages(messages: Message[]): ApiMessage[] {
  return messages.map((message): ApiMessage => {
    switch (message.role) {
      case "user":
        return { role: "user", content: message.text };
      case "assistant": {
        const content: Anthropic.ContentBlockParam[] = [];
        if (message.text) content.push({ type: "text", text: message.text });
        for (const call of message.toolCalls) {
          content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
        }
        return { role: "assistant", content };
      }
      case "tool":
        return {
          role: "user",
          content: message.results.map((result) => ({
            type: "tool_result" as const,
            tool_use_id: result.id,
            content: result.content,
            is_error: result.isError ?? false,
          })),
        };
    }
  });
}

export function toApiTools(tools: ToolSpec[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

export function fromApiContent(content: Anthropic.ContentBlock[]): LlmResponse {
  const text = content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  const toolCalls = content.flatMap((block) =>
    block.type === "tool_use" ? [{ id: block.id, name: block.name, input: block.input as Record<string, unknown> }] : [],
  );
  return { text, toolCalls };
}

export class AnthropicLlm implements LlmProvider {
  private readonly client: Anthropic;

  constructor(
    private readonly model: string = DEFAULT_MODEL,
    apiKey: string | undefined = process.env["ANTHROPIC_API_KEY"],
  ) {
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set.");
    this.client = new Anthropic({ apiKey });
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: request.maxTokens ?? 1024,
      system: request.system,
      messages: toApiMessages(request.messages),
      ...(request.tools?.length ? { tools: toApiTools(request.tools) } : {}),
    });
    return fromApiContent(response.content);
  }
}
