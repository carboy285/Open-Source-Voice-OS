import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Message } from "../src/core/types.js";
import { AnthropicLlm, DEFAULT_ANTHROPIC_MODEL } from "../src/providers/anthropic.js";
import { OpenAICompatibleLlm } from "../src/providers/openai-compatible.js";
import { BINARY_DIRS, parseWhisperOutput, resolveBinary, wav, WhisperCppStt } from "../src/providers/whisper-cpp.js";
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
    expect(result.text).toBe(
      // 100 bytes of audio, 300 ms of padding on each side (9600 bytes each) and the 44-byte WAV header.
      "got 19344 bytes args=-m /models/base.bin -f - -of murmur -nt -np -l auto --prompt Murmur, MCP -sns",
    );
  });

  it("reports a whisper that ignored stdin instead of an empty transcript", async () => {
    const dir = mkdtempSync(join(tmpdir(), "murmur-whisper-"));
    const bin = join(dir, "silent-whisper");
    writeFileSync(
      bin,
      `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on("end",()=>{process.stderr.write("read_audio_data: read 144 bytes from stdin\\nwarning: '--output-file -' used without any other '--output-*'\\n");});\n`,
    );
    chmodSync(bin, 0o755);
    const stt = new WhisperCppStt({ binary: bin, model: "/models/base.bin" });
    await expect(stt.transcribe({ pcm: new Uint8Array(100), sampleRate: 16000 })).rejects.toThrow(
      /silent-whisper printed no transcript/,
    );
  });

  it("finds a bare binary name in Homebrew folders before PATH", () => {
    const present = new Set([`${BINARY_DIRS[0]}/whisper-cli`, "/custom/bin/whisper-cli"]);
    const exists = (p: string) => present.has(p);
    expect(resolveBinary("whisper-cli", "/custom/bin", exists)).toBe("/opt/homebrew/bin/whisper-cli");
    expect(resolveBinary("other", "/custom/bin", (p) => p === "/custom/bin/other")).toBe("/custom/bin/other");
    expect(resolveBinary("missing", "/custom/bin", exists)).toBe("missing");
    expect(resolveBinary("/abs/whisper-cli", "", exists)).toBe("/abs/whisper-cli");
  });

  const realBinary = process.env.MURMUR_TEST_WHISPER;
  const realModel = process.env.MURMUR_TEST_WHISPER_MODEL;
  it.skipIf(!realBinary || !realModel)(
    "reads audio from stdin with a real whisper-cli",
    async () => {
      // Set MURMUR_TEST_WHISPER (binary) and MURMUR_TEST_WHISPER_MODEL (ggml file) to run this.
      // MURMUR_TEST_WHISPER_WAV may point at a 16 kHz mono PCM16 WAV of speech to also check the text.
      const { readFileSync } = await import("node:fs");
      const wavPath = process.env.MURMUR_TEST_WHISPER_WAV;
      const pcm = wavPath ? new Uint8Array(readFileSync(wavPath).subarray(44)) : new Uint8Array(32000);
      const stt = new WhisperCppStt({ binary: realBinary!, model: realModel!, timeoutMs: 120_000 });
      const result = await stt.transcribe({ pcm, sampleRate: 16000 }, { language: "en" });
      if (wavPath) expect(result.text.length).toBeGreaterThan(0);
    },
    180_000,
  );
});

describe("WhisperCppStt flag fallback", () => {
  it("drops -sns when this whisper-cli doesn't know it, and remembers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "murmur-whisper-"));
    const bin = join(dir, "old-whisper");
    const log = join(dir, "calls");
    // Like whisper-cli: an unknown flag prints an error and still exits 0.
    writeFileSync(
      bin,
      `#!${process.execPath}\nconst fs=require("fs");fs.appendFileSync(${JSON.stringify(log)},process.argv.slice(2).join(" ")+"\\n");process.stdin.resume();process.stdin.on("end",()=>{if(process.argv.includes("-sns")){process.stderr.write("error: unknown argument: -sns\\n");}else{process.stdout.write(" hello there\\n");}});\n`,
    );
    chmodSync(bin, 0o755);
    const stt = new WhisperCppStt({ binary: bin, model: "/models/base.bin" });
    const audio = { pcm: new Uint8Array(100), sampleRate: 16000 };
    expect((await stt.transcribe(audio)).text).toBe("hello there");
    expect((await stt.transcribe(audio)).text).toBe("hello there");
    const { readFileSync } = await import("node:fs");
    const calls = readFileSync(log, "utf8").trim().split("\n");
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain("-sns");
    expect(calls[1]).not.toContain("-sns");
    expect(calls[2]).not.toContain("-sns");
  });
});

describe("ParakeetCppStt", () => {
  it("pipes padded audio to parakeet-cli and reads the printed text", async () => {
    const { ParakeetCppStt } = await import("../src/providers/parakeet-cpp.js");
    const dir = mkdtempSync(join(tmpdir(), "murmur-parakeet-"));
    const bin = join(dir, "fake-parakeet");
    writeFileSync(
      bin,
      `#!${process.execPath}\nlet n=0;process.stdin.on("data",d=>n+=d.length);process.stdin.on("end",()=>{process.stderr.write("read_audio_data: read "+n+" bytes from stdin\\n");process.stdout.write("Hello"+" there, "+process.argv.slice(2).join(" ")+"\\n");});\n`,
    );
    chmodSync(bin, 0o755);
    const stt = new ParakeetCppStt({ binary: bin, model: "/models/parakeet.bin" });
    const result = await stt.transcribe({ pcm: new Uint8Array(100), sampleRate: 16000 });
    expect(result.text).toBe("Hello there, -m /models/parakeet.bin -np -f -");
  });

  const realBinary = process.env.MURMUR_TEST_PARAKEET;
  const realModel = process.env.MURMUR_TEST_PARAKEET_MODEL;
  it.skipIf(!realBinary || !realModel)(
    "runs a real parakeet-cli on piped audio",
    async () => {
      const { ParakeetCppStt } = await import("../src/providers/parakeet-cpp.js");
      const stt = new ParakeetCppStt({ binary: realBinary!, model: realModel!, timeoutMs: 120_000 });
      const result = await stt.transcribe({ pcm: new Uint8Array(32000), sampleRate: 16000 });
      expect(typeof result.text).toBe("string");
    },
    180_000,
  );
});
