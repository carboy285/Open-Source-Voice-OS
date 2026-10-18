import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Message } from "../src/core/types.js";
import { AnthropicLlm, DEFAULT_ANTHROPIC_MODEL } from "../src/providers/anthropic.js";
import { OpenAICompatibleLlm } from "../src/providers/openai-compatible.js";
import { parseWhisperOutput, wav, WhisperCppStt } from "../src/providers/whisper-cpp.js";
import { fakeFetch } from "./fakes/connectors.js";
import { searchFiles } from "./fakes/tools.js";

describe("AnthropicLlm", () => {
  function fakeClient(content: unknown[], stop = "tool_use") {
    const requests: Array<Record<string, unknown>> = [];
    const client = {
      messages: {
        create: async (body: Record<string, unknown>) => {
          requests.push(structuredClone(body));
          return { content, stop_reason: stop };
        },
      },
    };
    return { client: client as never, requests };
  }

  it("defaults the model, lets the user set it, and maps dotted tool names", async () => {
    const { client, requests } = fakeClient([
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "tool_use", id: "t1", name: "files__search", input: { query: "x" } },
    ]);
    expect(new AnthropicLlm({ apiKey: "k", client }).model).toBe(DEFAULT_ANTHROPIC_MODEL);
    const llm = new AnthropicLlm({ apiKey: "k", model: "my-model", client });
    const res = await llm.complete({ system: "s", messages: [{ role: "user", text: "hi" }], tools: [searchFiles] });
    expect(requests[0]).toMatchObject({ model: "my-model", system: "s", tools: [{ name: "files__search" }] });
    expect(res.toolCalls).toEqual([{ id: "t1", name: "files.search", input: { query: "x" } }]);

    const history: Message[] = [
      { role: "user", text: "hi" },
      { role: "assistant", text: res.text, toolCalls: res.toolCalls, raw: res.raw },
      { role: "tool", results: [{ id: "t1", content: "nope", isError: true }] },
    ];
    await llm.complete({ system: "s", messages: history, tools: [searchFiles] });
    const sent = requests[1]!.messages as Array<{ role: string; content: unknown }>;
    expect(sent[1]!.content).toEqual(res.raw);
    expect(sent[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "nope", is_error: true }],
    });
  });

  it("reports a refusal as text without tool calls", async () => {
    const { client } = fakeClient([], "refusal");
    const res = await new AnthropicLlm({ apiKey: "k", client }).complete({ system: "", messages: [] });
    expect(res).toMatchObject({ toolCalls: [], text: expect.stringMatching(/declined/) });
  });
});

describe("OpenAICompatibleLlm", () => {
  it("posts to /v1/chat/completions and parses tool calls", async () => {
    const { fn, calls } = fakeFetch(() => ({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "c1", type: "function", function: { name: "files__search", arguments: '{"query":"tax"}' } },
            ],
          },
        },
      ],
    }));
    const llm = new OpenAICompatibleLlm({ baseUrl: "http://localhost:11434/", model: "local", apiKey: "k", fetch: fn });
    const res = await llm.complete({
      system: "sys",
      tools: [searchFiles],
      messages: [
        { role: "user", text: "find" },
        { role: "assistant", text: "", toolCalls: [{ id: "c0", name: "files.search", input: { query: "a" } }] },
        { role: "tool", results: [{ id: "c0", content: "none" }] },
      ],
    });
    expect(calls[0]!.url).toBe("http://localhost:11434/v1/chat/completions");
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(body.messages[2].tool_calls[0].function).toEqual({ name: "files__search", arguments: '{"query":"a"}' });
    expect(body.tools[0].function.name).toBe("files__search");
    expect(res.toolCalls).toEqual([{ id: "c1", name: "files.search", input: { query: "tax" } }]);
  });

  it("throws on HTTP errors", async () => {
    const { fn } = fakeFetch(() => ({ error: { message: "bad key" } }), 401);
    await expect(
      new OpenAICompatibleLlm({ baseUrl: "http://x", model: "m", fetch: fn }).complete({ system: "", messages: [] }),
    ).rejects.toThrow(/bad key/);
  });
});

describe("WhisperCppStt", () => {
  it("builds a WAV header in memory", () => {
    const buf = wav({ pcm: new Uint8Array(32000), sampleRate: 16000 });
    expect(buf.subarray(0, 4).toString()).toBe("RIFF");
    expect(buf.readUInt32LE(24)).toBe(16000);
    expect(buf.length).toBe(32044);
  });

  it("parses output and the detected language", () => {
    expect(
      parseWhisperOutput(" Hello there.\n[BLANK_AUDIO]\n", "whisper: auto-detected language: ja (p = 0.9)"),
    ).toEqual({
      text: "Hello there.",
      language: "ja",
    });
  });

  it("pipes audio to the configured binary on stdin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "murmur-whisper-"));
    const bin = join(dir, "fake-whisper");
    writeFileSync(
      bin,
      `#!${process.execPath}\nlet n=0;process.stdin.on("data",d=>n+=d.length);process.stdin.on("end",()=>{process.stderr.write("auto-detected language: en\\n");process.stdout.write(" got "+n+" bytes args="+process.argv.slice(2).join(" ")+"\\n");});\n`,
    );
    chmodSync(bin, 0o755);
    const stt = new WhisperCppStt({ binary: bin, model: "/models/base.bin" });
    const result = await stt.transcribe({ pcm: new Uint8Array(100), sampleRate: 16000 }, { prompt: "Murmur, MCP" });
    expect(result.language).toBe("en");
    expect(result.text).toBe("got 144 bytes args=-m /models/base.bin -f - -nt -np -l auto --prompt Murmur, MCP");
  });
});
