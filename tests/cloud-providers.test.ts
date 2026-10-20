import { describe, expect, it } from "vitest";
import { MurmurCore } from "../src/core/app.js";
import {
  LLM_PRESETS,
  STT_PRESETS,
  TTS_PRESETS,
  allProviderKeyNames,
  findLlmPreset,
  llmKeyName,
  sttKeyName,
  ttsKeyName,
} from "../src/providers/catalog.js";
import { CloudStt, nvidiaLanguage } from "../src/providers/cloud-stt.js";
import { CloudTts, MAX_SPOKEN_CHARS, trimForSpeech } from "../src/providers/cloud-tts.js";
import { OpenAICompatibleLlm, plainSchema } from "../src/providers/openai-compatible.js";
import { MemorySecretStore } from "../src/secrets/store.js";
import { ScriptedApprovalUi } from "./fakes/approval.js";

type Call = { url: string; init: RequestInit };
function fakeFetch(reply: () => Response) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return reply();
  }) as typeof fetch;
  return { fn, calls };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const audio = { pcm: new Uint8Array(32000), sampleRate: 16000 };
const header = (call: Call, name: string) => (call.init.headers as Record<string, string>)[name];

describe("provider catalog", () => {
  it("has unique ids, secure addresses for hosted services, and a key name for each", () => {
    for (const list of [LLM_PRESETS, STT_PRESETS, TTS_PRESETS]) {
      expect(new Set(list.map((p) => p.id)).size).toBe(list.length);
    }
    for (const p of LLM_PRESETS) expect(p.local || p.chatUrl.startsWith("https://"), p.id).toBe(true);
    for (const p of [...STT_PRESETS, ...TTS_PRESETS]) {
      if (p.url) expect(p.url.startsWith("https://") || p.url.startsWith("http://localhost"), p.id).toBe(true);
    }
    expect(llmKeyName("anthropic")).toBe("llm/apiKey");
    expect(llmKeyName("openai-compatible")).toBe("llm/apiKey");
    expect(llmKeyName("gemini")).toBe("llm/key/gemini");
    expect(sttKeyName("groq")).toBe("stt/key/groq");
    expect(ttsKeyName("elevenlabs")).toBe("tts/key/elevenlabs");
    expect(allProviderKeyNames()).toEqual(
      expect.arrayContaining(["llm/key/gemini", "stt/key/deepgram", "tts/key/openai"]),
    );
  });

  it("includes the popular services", () => {
    const names = (list: ReadonlyArray<{ id: string }>) => list.map((p) => p.id);
    expect(names(LLM_PRESETS)).toEqual(
      expect.arrayContaining([
        "openai",
        "gemini",
        "opencode",
        "openrouter",
        "groq",
        "mistral",
        "deepseek",
        "xai",
        "nvidia",
        "ollama",
      ]),
    );
    expect(names(STT_PRESETS)).toEqual(expect.arrayContaining(["openai", "groq", "deepgram", "elevenlabs", "nvidia"]));
    expect(names(TTS_PRESETS)).toEqual(expect.arrayContaining(["openai", "elevenlabs", "deepgram"]));
  });
});

describe("chat services", () => {
  const request = { system: "s", messages: [{ role: "user" as const, text: "hi" }], maxTokens: 50 };
  it("uses a full chat address as given, and still adds /v1/chat/completions to a bare server address", async () => {
    const a = fakeFetch(() => json({ choices: [{ message: { content: "ok" } }] }));
    await new OpenAICompatibleLlm({ baseUrl: findLlmPreset("gemini")!.chatUrl, model: "m", fetch: a.fn }).complete(
      request,
    );
    expect(a.calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    const b = fakeFetch(() => json({ choices: [{ message: { content: "ok" } }] }));
    await new OpenAICompatibleLlm({ baseUrl: "http://localhost:11434/", model: "m", fetch: b.fn }).complete(request);
    expect(b.calls[0]!.url).toBe("http://localhost:11434/v1/chat/completions");
  });

  it("asks OpenAI for max_completion_tokens and others for max_tokens", async () => {
    const f = fakeFetch(() => json({ choices: [{ message: { content: "ok" } }] }));
    await new OpenAICompatibleLlm({
      baseUrl: "https://x",
      model: "m",
      maxTokensParam: "max_completion_tokens",
      fetch: f.fn,
    }).complete(request);
    await new OpenAICompatibleLlm({ baseUrl: "https://x", model: "m", fetch: f.fn }).complete(request);
    expect(JSON.parse(String(f.calls[0]!.init.body))).toMatchObject({ max_completion_tokens: 50 });
    expect(JSON.parse(String(f.calls[0]!.init.body))).not.toHaveProperty("max_tokens");
    expect(JSON.parse(String(f.calls[1]!.init.body))).toMatchObject({ max_tokens: 50 });
  });

  it("trims tool schemas for servers that take only a plain subset", () => {
    expect(
      plainSchema({
        type: "object",
        additionalProperties: false,
        properties: {
          to: { type: "string", format: "email" },
          when: { type: "string", format: "date-time" },
          format: { type: "string" },
          list: { type: "array", items: { type: "object", additionalProperties: false, properties: {} } },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        to: { type: "string" },
        when: { type: "string", format: "date-time" },
        format: { type: "string" },
        list: { type: "array", items: { type: "object", properties: {} } },
      },
    });
  });
});

describe("speech to text services", () => {
  const stt = (
    id: string,
    over: Partial<ConstructorParameters<typeof CloudStt>[0]> = {},
    f = fakeFetch(() => json({ text: " hello there " })),
  ) => {
    const p = STT_PRESETS.find((x) => x.id === id)!;
    return {
      f,
      provider: new CloudStt({
        api: p.api,
        url: p.url,
        model: p.defaultModel,
        apiKey: "sk-secret",
        fetch: f.fn,
        ...over,
      }),
    };
  };

  it("sends OpenAI, Groq and Mistral a multipart form with the file, model and language", async () => {
    for (const id of ["openai", "groq", "mistral"]) {
      const { f, provider } = stt(id);
      const result = await provider.transcribe(audio, { language: "en", prompt: "Murmur" });
      expect(result.text).toBe("hello there");
      const call = f.calls[0]!;
      expect(call.url).toBe(STT_PRESETS.find((p) => p.id === id)!.url);
      expect(header(call, "authorization")).toBe("Bearer sk-secret");
      const form = call.init.body as FormData;
      expect(form.get("model")).toBe(STT_PRESETS.find((p) => p.id === id)!.defaultModel);
      expect(form.get("language")).toBe("en");
      expect(form.get("prompt")).toBe("Murmur");
      expect((form.get("file") as File).name).toBe("audio.wav");
    }
  });

  it("sends Deepgram the audio itself with a Token header, and reads its answer", async () => {
    const f = fakeFetch(() =>
      json({ results: { channels: [{ detected_language: "fr", alternatives: [{ transcript: "bonjour" }] }] } }),
    );
    const { provider } = stt("deepgram", {}, f);
    expect(await provider.transcribe(audio)).toEqual({ text: "bonjour", language: "fr" });
    const call = f.calls[0]!;
    expect(call.url).toContain("model=nova-3");
    expect(call.url).toContain("detect_language=true");
    expect(header(call, "authorization")).toBe("Token sk-secret");
    expect(header(call, "content-type")).toBe("audio/wav");
  });

  it("sends ElevenLabs model_id and its own key header", async () => {
    const { f, provider } = stt("elevenlabs");
    await provider.transcribe(audio, { language: "ja" });
    const call = f.calls[0]!;
    expect(header(call, "xi-api-key")).toBe("sk-secret");
    expect(call.init.headers as object).not.toHaveProperty("authorization");
    const form = call.init.body as FormData;
    expect(form.get("model_id")).toBe("scribe_v1");
    expect(form.get("language_code")).toBe("ja");
  });

  it("sends NVIDIA's speech container a region language and needs no key", async () => {
    const { f, provider } = stt("nvidia", { apiKey: undefined });
    await provider.transcribe(audio, { language: "es" });
    const call = f.calls[0]!;
    expect(call.url).toBe("http://localhost:9000/v1/audio/transcriptions");
    expect(call.init.headers as object).not.toHaveProperty("authorization");
    expect((call.init.body as FormData).get("language")).toBe("es-US");
    expect(nvidiaLanguage()).toBe("en-US");
    expect(nvidiaLanguage("pt-BR")).toBe("pt-BR");
    expect(nvidiaLanguage("xx")).toBe("en-US");
  });

  it("explains a refused key or a server error without repeating the key", async () => {
    const refused = stt(
      "openai",
      {},
      fakeFetch(() => json({ error: { message: "bad sk-secret" } }, 401)),
    );
    await expect(refused.provider.transcribe(audio)).rejects.toThrow(/didn't accept the key/);
    const broken = stt(
      "groq",
      {},
      fakeFetch(() => json({ error: { message: "model sk-secret is gone" } }, 404)),
    );
    const error = await broken.provider.transcribe(audio).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/said 404/);
    expect((error as Error).message).not.toContain("sk-secret");
    await expect(stt("custom", { url: "" }).provider.transcribe(audio)).rejects.toThrow(
      /address of your speech server/,
    );
  });
});

describe("text to speech services", () => {
  const tts = (
    id: string,
    over: Partial<ConstructorParameters<typeof CloudTts>[0]> = {},
    f = fakeFetch(() => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } })),
  ) => {
    const p = TTS_PRESETS.find((x) => x.id === id)!;
    return {
      f,
      provider: new CloudTts({
        api: p.api,
        url: p.url,
        model: p.defaultModel,
        voice: p.defaultVoice,
        apiKey: "sk-secret",
        fetch: f.fn,
        ...over,
      }),
    };
  };

  it("asks OpenAI for an MP3 of the text with the chosen voice", async () => {
    const { f, provider } = tts("openai");
    const speech = await provider.synthesize("Hello there.");
    expect(speech.audio).toEqual(Buffer.from([1, 2, 3]));
    expect(speech.mediaType).toBe("audio/mpeg");
    expect(f.calls[0]!.url).toBe("https://api.openai.com/v1/audio/speech");
    expect(header(f.calls[0]!, "authorization")).toBe("Bearer sk-secret");
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: "Hello there.",
      response_format: "mp3",
    });
  });

  it("puts the ElevenLabs voice in the address and the model in the body", async () => {
    const { f, provider } = tts("elevenlabs", { voice: "abc 123" });
    await provider.synthesize("Hi");
    expect(f.calls[0]!.url).toBe("https://api.elevenlabs.io/v1/text-to-speech/abc%20123?output_format=mp3_44100_128");
    expect(header(f.calls[0]!, "xi-api-key")).toBe("sk-secret");
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ text: "Hi", model_id: "eleven_flash_v2_5" });
  });

  it("puts the Deepgram voice in the address with a Token header", async () => {
    const { f, provider } = tts("deepgram");
    await provider.synthesize("Hi");
    expect(f.calls[0]!.url).toBe("https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=mp3");
    expect(header(f.calls[0]!, "authorization")).toBe("Token sk-secret");
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ text: "Hi" });
  });

  it("cuts a long reply at a sentence and refuses empty text, bad keys and empty audio", async () => {
    const long = `${"A sentence. ".repeat(500)}`;
    const trimmed = trimForSpeech(long);
    expect(trimmed.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS);
    expect(trimmed.endsWith(".")).toBe(true);
    await expect(tts("openai").provider.synthesize("   ")).rejects.toThrow(/nothing to say/);
    const refused = tts(
      "openai",
      {},
      fakeFetch(() => new Response("no", { status: 401 })),
    );
    await expect(refused.provider.synthesize("hi")).rejects.toThrow(/didn't accept the key/);
    const empty = tts(
      "openai",
      {},
      fakeFetch(() => new Response(new Uint8Array(), { status: 200 })),
    );
    await expect(empty.provider.synthesize("hi")).rejects.toThrow(/no audio/);
  });
});

describe("choosing a service in the core", () => {
  function core(secrets = new MemorySecretStore(), fetchImpl?: typeof fetch) {
    const c = new MurmurCore({
      databasePath: ":memory:",
      mcpConfigPath: "/nonexistent/mcp.json",
      fetch: fetchImpl,
      bridge: {
        insertText: async () => ({ ok: true, method: "test" }),
        captureContext: async () => ({}),
        secrets,
        approvals: new ScriptedApprovalUi([]),
        emit: () => {},
      },
    });
    return { c, secrets };
  }

  it("needs a key for a hosted AI service but not for one on this computer", async () => {
    const { c, secrets } = core();
    c.settings.set("llm.provider", "gemini");
    expect(await c.llm()).toBeUndefined();
    secrets.values.set("llm/key/gemini", "k");
    expect(await c.llm()).toBeInstanceOf(OpenAICompatibleLlm);
    c.settings.set("llm.provider", "ollama");
    expect(await c.llm()).toBeInstanceOf(OpenAICompatibleLlm);
  });

  it("uses the service's own sample model until you type another, and keeps each service's key apart", async () => {
    const f = fakeFetch(() => json({ choices: [{ message: { content: "ok" } }] }));
    const { c, secrets } = core(undefined, f.fn);
    secrets.values.set("llm/key/openai", "key-a");
    secrets.values.set("llm/key/groq", "key-b");
    c.settings.set("llm.provider", "groq");
    await (await c.llm())!.complete({ system: "s", messages: [{ role: "user", text: "hi" }] });
    expect(f.calls[0]!.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(header(f.calls[0]!, "authorization")).toBe("Bearer key-b");
    expect(JSON.parse(String(f.calls[0]!.init.body)).model).toBe("llama-3.3-70b-versatile");
    c.settings.set("llm.model", "my-model");
    await (await c.llm())!.complete({ system: "s", messages: [{ role: "user", text: "hi" }] });
    expect(JSON.parse(String(f.calls[1]!.init.body)).model).toBe("my-model");
  });

  it("transcribes with a hosted service only when one is chosen and has a key, and otherwise stays local", async () => {
    const { c, secrets } = core();
    expect(await c.stt()).toBeUndefined();
    c.settings.set("stt.provider", "deepgram");
    expect(await c.stt()).toBeUndefined();
    secrets.values.set("stt/key/deepgram", "k");
    expect(await c.stt()).toBeInstanceOf(CloudStt);
    c.settings.set("stt.provider", "nvidia");
    expect(await c.stt()).toBeInstanceOf(CloudStt);
    c.settings.set("stt.provider", "");
    expect(await c.stt()).toBeUndefined();
  });

  it("makes a hosted voice only when one is chosen and has a key, and returns it as base64", async () => {
    const f = fakeFetch(() => new Response(new Uint8Array([9, 8, 7]), { headers: { "content-type": "audio/mpeg" } }));
    const { c, secrets } = core(undefined, f.fn);
    await expect(c.synthesize("hi")).rejects.toThrow(/No hosted voice/);
    c.settings.set("tts.provider", "openai");
    await expect(c.synthesize("hi")).rejects.toThrow(/No hosted voice/);
    secrets.values.set("tts/key/openai", "k");
    expect(await c.synthesize("hi")).toEqual({
      audio: Buffer.from([9, 8, 7]).toString("base64"),
      mediaType: "audio/mpeg",
    });
  });

  it("lists the services for Settings without any keys", () => {
    const { c } = core();
    const catalog = c.providerCatalog();
    expect(catalog.llm.map((p) => p.id)).toContain("gemini");
    expect(JSON.stringify(catalog)).not.toMatch(/key":|sk-/);
  });
});
