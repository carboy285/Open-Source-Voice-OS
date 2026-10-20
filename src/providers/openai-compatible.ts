import type { LlmProvider, LlmRequest, LlmResponse, Message, ToolCall } from "../core/types.js";
import { WireNames } from "./wire-names.js";

export interface OpenAICompatibleOptions {
  /**
   * A server's address. A full chat address (ending "/chat/completions") is used as given; anything else gets
   * "/v1/chat/completions" added, so "http://localhost:11434" works.
   */
  baseUrl: string;
  /** The server only takes a plain subset of JSON Schema for tool inputs, so the rest is dropped from them. */
  plainSchemas?: boolean;
  /** OpenAI's newer models only accept `max_completion_tokens`. */
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
  model: string;
  apiKey?: string;
  /** The model behind this server accepts images (a setting; unknown from the outside). */
  vision?: boolean;
  fetch?: typeof fetch;
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

/** Any server that speaks the chat-completions format: local runtimes or hosted ones, with tool calls. */
export class OpenAICompatibleLlm implements LlmProvider {
  /** Set by the user: a server may or may not run a model that sees images. */
  get supportsImages(): boolean {
    return this.options.vision === true;
  }

  constructor(private readonly options: OpenAICompatibleOptions) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const names = new WireNames();
    const base = this.options.baseUrl.replace(/\/+$/, "");
    const url = base.endsWith("/chat/completions") ? base : `${base.replace(/\/v1$/, "")}/v1/chat/completions`;
    const body = {
      model: this.options.model,
      [this.options.maxTokensParam ?? "max_tokens"]: request.maxTokens ?? 1024,
      messages: [{ role: "system", content: request.system } as ChatMessage, ...toChat(request.messages, names)],
      ...(request.tools?.length
        ? {
            tools: request.tools.map((t) => ({
              type: "function",
              function: {
                name: names.wire(t.name),
                description: t.description,
                parameters: this.options.plainSchemas ? plainSchema(t.inputSchema) : t.inputSchema,
              },
            })),
          }
        : {}),
    };
    const res = await (this.options.fetch ?? fetch)(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: request.signal,
    });
    const json = (await res.json().catch(() => ({}))) as {
      choices?: Array<{ message?: ChatMessage }>;
      error?: { message?: string };
    };
    if (!res.ok) throw new Error(`Model request failed (${res.status}): ${json.error?.message ?? "no details"}`);
    const message = json.choices?.[0]?.message;
    const toolCalls: ToolCall[] = (message?.tool_calls ?? []).map((c, i) => ({
      id: c.id || `call_${i}`,
      name: names.unwire(c.function.name),
      input: parseArgs(c.function.arguments),
    }));
    return { text: typeof message?.content === "string" ? message.content : "", toolCalls };
  }
}

/** Drops what a plain-schema server rejects: additionalProperties, and string formats other than date-time. */
export function plainSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(plainSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "additionalProperties" || key === "$schema") continue;
    if (key === "format" && value !== "date-time" && value !== "enum") continue;
    out[key] =
      key === "properties" && value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, plainSchema(v)]))
        : plainSchema(value);
  }
  return out;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw || "{}") as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toChat(messages: Message[], names: WireNames): ChatMessage[] {
  return messages.flatMap((m): ChatMessage[] => {
    if (m.role === "user") {
      if (!m.images?.length) return [{ role: "user", content: m.text }];
      return [
        {
          role: "user",
          content: [
            ...m.images.map((image) => ({
              type: "image_url" as const,
              image_url: { url: `data:${image.mediaType};base64,${image.data}` },
            })),
            { type: "text" as const, text: m.text },
          ],
        },
      ];
    }
    if (m.role === "tool") return m.results.map((r) => ({ role: "tool", tool_call_id: r.id, content: r.content }));
    return [
      {
        role: "assistant",
        content: m.text || null,
        ...(m.toolCalls.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: "function" as const,
                function: { name: names.wire(c.name), arguments: JSON.stringify(c.input) },
              })),
            }
          : {}),
      },
    ];
  });
}
