import type { LlmProvider, LlmRequest, LlmResponse, Message, ToolCall } from "../core/types.js";
import type { ChatGptSession } from "./chatgpt-auth.js";
import { WireNames } from "./wire-names.js";

export const CHATGPT_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
export const DEFAULT_CHATGPT_MODEL = "gpt-5";

export interface ChatGptCodexOptions {
  session: ChatGptSession;
  model?: string;
  fetch?: typeof fetch;
}

type Item = Record<string, unknown>;

/** The model behind a ChatGPT subscription, through the same Responses endpoint Codex uses. */
export class ChatGptCodexLlm implements LlmProvider {
  readonly supportsImages = true;

  constructor(private readonly options: ChatGptCodexOptions) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const names = new WireNames();
    const body = {
      model: this.options.model || DEFAULT_CHATGPT_MODEL,
      instructions: request.system,
      input: toInput(request.messages, names),
      tools: (request.tools ?? []).map((t) => ({
        type: "function",
        name: names.wire(t.name),
        description: t.description,
        parameters: t.inputSchema,
        strict: false,
      })),
      tool_choice: "auto",
      parallel_tool_calls: false,
      store: false,
      stream: true,
    };
    let res = await this.send(body, request.signal, false);
    if (res.status === 401) res = await this.send(body, request.signal, true);
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Model request failed (${res.status}): ${errorMessage(detail)}`);
    }
    return readStream(res, names);
  }

  private async send(body: unknown, signal: AbortSignal | undefined, forceRefresh: boolean): Promise<Response> {
    const credentials = await this.options.session.credentials(forceRefresh);
    if (!credentials) throw new Error("Not signed in to ChatGPT. Open Settings › Agent and sign in.");
    return (this.options.fetch ?? fetch)(CHATGPT_RESPONSES_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${credentials.accessToken}`,
        ...(credentials.accountId ? { "chatgpt-account-id": credentials.accountId } : {}),
        "openai-beta": "responses=experimental",
        originator: "murmur",
      },
      body: JSON.stringify(body),
      signal,
    });
  }
}

function toInput(messages: Message[], names: WireNames): Item[] {
  const items: Item[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      items.push({
        type: "message",
        role: "user",
        content: [
          ...(message.images ?? []).map((image) => ({
            type: "input_image",
            image_url: `data:${image.mediaType};base64,${image.data}`,
          })),
          { type: "input_text", text: message.text },
        ],
      });
    } else if (message.role === "assistant") {
      if (message.text)
        items.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: message.text }] });
      for (const call of message.toolCalls) {
        items.push({
          type: "function_call",
          call_id: call.id,
          name: names.wire(call.name),
          arguments: JSON.stringify(call.input),
        });
      }
    } else {
      for (const result of message.results) {
        items.push({ type: "function_call_output", call_id: result.id, output: result.content });
      }
    }
  }
  return items;
}

function errorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string }; detail?: string };
    return parsed.error?.message ?? parsed.detail ?? "no details";
  } catch {
    return body.slice(0, 200) || "no details";
  }
}

async function readStream(res: Response, names: WireNames): Promise<LlmResponse> {
  let text = "";
  const toolCalls: ToolCall[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  const handle = (data: string) => {
    if (!data || data === "[DONE]") return;
    let event: {
      type?: string;
      delta?: string;
      item?: Item;
      message?: string;
      response?: { error?: { message?: string } };
    };
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    switch (event.type) {
      case "response.output_text.delta":
        text += event.delta ?? "";
        break;
      case "response.output_item.done":
        if (event.item?.type === "function_call") {
          toolCalls.push({
            id: String(event.item.call_id ?? `call_${toolCalls.length}`),
            name: names.unwire(String(event.item.name ?? "")),
            input: parseArgs(String(event.item.arguments ?? "")),
          });
        }
        break;
      case "response.failed":
        throw new Error(`Model request failed: ${event.response?.error?.message ?? "no details"}`);
      case "error":
        throw new Error(`Model request failed: ${event.message ?? "no details"}`);
    }
  };
  const reader = res.body?.getReader();
  if (!reader) throw new Error("Model request failed: no response body.");
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: !done });
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      handle(
        block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n"),
      );
    }
    if (done) break;
  }
  if (buffer.trim())
    handle(
      buffer
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("\n"),
    );
  return { text, toolCalls };
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
