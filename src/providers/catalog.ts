/**
 * The AI, speech-to-text and text-to-speech services Murmur can use. Murmur ships no keys: each one is used with the
 * user's own account. Names, addresses and sample model names can go out of date; the model field is always editable.
 * Most hosted AI services speak the same chat format, so one provider class serves them all.
 */

export interface LlmPreset {
  id: string;
  name: string;
  /** The full address of the chat endpoint. */
  chatUrl: string;
  /** A model that exists today, offered as the starting point. The user can type any other. */
  defaultModel: string;
  /** Where to get a key, shown as a link. */
  keyUrl?: string;
  /** Runs on this computer: no key, and nothing leaves it. */
  local?: boolean;
  /** Whether the default model accepts pictures. */
  vision?: boolean;
  /** OpenAI's newer models want `max_completion_tokens`. */
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
  /** Accepts only a plain subset of JSON Schema for tools (no additionalProperties, few string formats). */
  plainSchemas?: boolean;
}

export const LLM_PRESETS: readonly LlmPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    chatUrl: "https://api.openai.com/v1/chat/completions",
    defaultModel: "gpt-4.1-mini",
    keyUrl: "https://platform.openai.com/api-keys",
    vision: true,
    maxTokensParam: "max_completion_tokens",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    chatUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    defaultModel: "gemini-2.5-flash",
    keyUrl: "https://aistudio.google.com/apikey",
    vision: true,
    plainSchemas: true,
  },
  {
    id: "opencode",
    name: "OpenCode Zen",
    chatUrl: "https://opencode.ai/zen/v1/chat/completions",
    defaultModel: "big-pickle",
    keyUrl: "https://opencode.ai/auth",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    chatUrl: "https://openrouter.ai/api/v1/chat/completions",
    defaultModel: "openai/gpt-4o-mini",
    keyUrl: "https://openrouter.ai/keys",
  },
  {
    id: "groq",
    name: "Groq",
    chatUrl: "https://api.groq.com/openai/v1/chat/completions",
    defaultModel: "llama-3.3-70b-versatile",
    keyUrl: "https://console.groq.com/keys",
  },
  {
    id: "together",
    name: "Together AI",
    chatUrl: "https://api.together.xyz/v1/chat/completions",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    keyUrl: "https://api.together.ai/settings/api-keys",
  },
  {
    id: "mistral",
    name: "Mistral",
    chatUrl: "https://api.mistral.ai/v1/chat/completions",
    defaultModel: "mistral-small-latest",
    keyUrl: "https://console.mistral.ai/api-keys",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    chatUrl: "https://api.deepseek.com/chat/completions",
    defaultModel: "deepseek-chat",
    keyUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "xai",
    name: "xAI (Grok)",
    chatUrl: "https://api.x.ai/v1/chat/completions",
    defaultModel: "grok-4",
    keyUrl: "https://console.x.ai",
    vision: true,
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    chatUrl: "https://api.fireworks.ai/inference/v1/chat/completions",
    defaultModel: "accounts/fireworks/models/llama-v3p3-70b-instruct",
    keyUrl: "https://fireworks.ai/account/api-keys",
  },
  {
    id: "cerebras",
    name: "Cerebras",
    chatUrl: "https://api.cerebras.ai/v1/chat/completions",
    defaultModel: "llama-3.3-70b",
    keyUrl: "https://cloud.cerebras.ai",
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM (build.nvidia.com)",
    chatUrl: "https://integrate.api.nvidia.com/v1/chat/completions",
    defaultModel: "meta/llama-3.3-70b-instruct",
    keyUrl: "https://build.nvidia.com",
  },
  {
    id: "ollama",
    name: "Ollama (on this computer)",
    chatUrl: "http://localhost:11434/v1/chat/completions",
    defaultModel: "llama3.2",
    local: true,
  },
  {
    id: "lmstudio",
    name: "LM Studio (on this computer)",
    chatUrl: "http://localhost:1234/v1/chat/completions",
    defaultModel: "",
    local: true,
  },
];

export const findLlmPreset = (id: unknown): LlmPreset | undefined => LLM_PRESETS.find((p) => p.id === id);

/** Where a provider's key is kept: Anthropic and the "other server" option keep the original single key. */
export const llmKeyName = (provider: string): string =>
  provider === "anthropic" || provider === "openai-compatible" ? "llm/apiKey" : `llm/key/${provider}`;

// Speech to text

export type SttApi = "openai" | "deepgram" | "elevenlabs" | "nvidia" | "riva";

export interface SttPreset {
  id: string;
  name: string;
  api: SttApi;
  /** Full address of the transcription endpoint. */
  url: string;
  defaultModel: string;
  keyUrl?: string;
}

export const STT_PRESETS: readonly SttPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    api: "openai",
    url: "https://api.openai.com/v1/audio/transcriptions",
    defaultModel: "gpt-4o-mini-transcribe",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "groq",
    name: "Groq",
    api: "openai",
    url: "https://api.groq.com/openai/v1/audio/transcriptions",
    defaultModel: "whisper-large-v3-turbo",
    keyUrl: "https://console.groq.com/keys",
  },
  {
    id: "deepgram",
    name: "Deepgram",
    api: "deepgram",
    url: "https://api.deepgram.com/v1/listen",
    defaultModel: "nova-3",
    keyUrl: "https://console.deepgram.com",
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    api: "elevenlabs",
    url: "https://api.elevenlabs.io/v1/speech-to-text",
    defaultModel: "scribe_v1",
    keyUrl: "https://elevenlabs.io/app/settings/api-keys",
  },
  {
    id: "mistral",
    name: "Mistral (Voxtral)",
    api: "openai",
    url: "https://api.mistral.ai/v1/audio/transcriptions",
    defaultModel: "voxtral-mini-latest",
    keyUrl: "https://console.mistral.ai/api-keys",
  },
  {
    // NVIDIA's hosted speech models on build.nvidia.com. They speak gRPC and need your key and the model's Function ID.
    id: "nvidia-hosted",
    name: "NVIDIA hosted (build.nvidia.com)",
    api: "riva",
    url: "https://grpc.nvcf.nvidia.com:443",
    defaultModel: "",
    keyUrl: "https://build.nvidia.com/nvidia/parakeet-ctc-1_1b-asr/api",
  },
  {
    // NVIDIA's speech microservice (Parakeet, Canary) running in a container you run yourself, on port 9000 by default.
    // NVIDIA's hosted speech endpoints use gRPC, which Murmur does not speak.
    id: "nvidia",
    name: "NVIDIA Speech NIM (your own server)",
    api: "nvidia",
    url: "http://localhost:9000/v1/audio/transcriptions",
    defaultModel: "",
    keyUrl: "https://docs.nvidia.com/nim/speech/latest/get-started/tutorials/asr.html",
  },
  {
    // faster-whisper-server, LocalAI, a Whisper container on your own network: anything that copies OpenAI's address.
    id: "custom",
    name: "Another server (OpenAI-style)",
    api: "openai",
    url: "",
    defaultModel: "whisper-1",
  },
];

export const findSttPreset = (id: unknown): SttPreset | undefined => STT_PRESETS.find((p) => p.id === id);
export const sttKeyName = (provider: string): string => `stt/key/${provider}`;

// Text to speech

export type TtsApi = "openai" | "deepgram" | "elevenlabs";

export interface TtsPreset {
  id: string;
  name: string;
  api: TtsApi;
  /** Full address of the speech endpoint. For ElevenLabs the voice is added to it. */
  url: string;
  defaultModel: string;
  defaultVoice: string;
  keyUrl?: string;
}

export const TTS_PRESETS: readonly TtsPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    api: "openai",
    url: "https://api.openai.com/v1/audio/speech",
    defaultModel: "gpt-4o-mini-tts",
    defaultVoice: "alloy",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    api: "elevenlabs",
    url: "https://api.elevenlabs.io/v1/text-to-speech",
    defaultModel: "eleven_flash_v2_5",
    // "Rachel", one of ElevenLabs' stock voices. Any voice ID from the user's own library can replace it.
    defaultVoice: "21m00Tcm4TlvDq8ikWAM",
    keyUrl: "https://elevenlabs.io/app/settings/api-keys",
  },
  {
    id: "deepgram",
    name: "Deepgram Aura",
    api: "deepgram",
    url: "https://api.deepgram.com/v1/speak",
    defaultModel: "aura-2-thalia-en",
    defaultVoice: "",
    keyUrl: "https://console.deepgram.com",
  },
  {
    // Kokoro-FastAPI, openedai-speech and similar servers on your own computer copy OpenAI's address.
    id: "custom",
    name: "Another server (OpenAI-style)",
    api: "openai",
    url: "",
    defaultModel: "tts-1",
    defaultVoice: "alloy",
  },
];

export const findTtsPreset = (id: unknown): TtsPreset | undefined => TTS_PRESETS.find((p) => p.id === id);
export const ttsKeyName = (provider: string): string => `tts/key/${provider}`;

/** Every secret name this file can produce, so "Delete all data" removes them all. */
export function allProviderKeyNames(): string[] {
  return [
    "llm/apiKey",
    ...LLM_PRESETS.map((p) => llmKeyName(p.id)),
    ...STT_PRESETS.map((p) => sttKeyName(p.id)),
    ...TTS_PRESETS.map((p) => ttsKeyName(p.id)),
  ];
}
