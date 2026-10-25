import type { LlmProvider, SttProvider } from "./core/types.js";
import { AnthropicLlm } from "./providers/anthropic.js";
import { CodexCliLlm } from "./providers/codex.js";
import { WhisperCppStt } from "./providers/whisper.js";

type Env = Record<string, string | undefined>;

/**
 * VOICEOS_LLM=codex (default): the user's Codex CLI, signed in with ChatGPT via `voiceos login`.
 * VOICEOS_LLM=anthropic: Claude through ANTHROPIC_API_KEY.
 */
export function createLlm(env: Env = process.env): LlmProvider {
  const provider = env["VOICEOS_LLM"] ?? "codex";
  switch (provider) {
    case "codex":
      return new CodexCliLlm({ binary: env["VOICEOS_CODEX_BIN"] ?? "codex", model: env["VOICEOS_MODEL"] });
    case "anthropic":
      return new AnthropicLlm(env["VOICEOS_MODEL"], env["ANTHROPIC_API_KEY"]);
    default:
      throw new Error(`Unknown VOICEOS_LLM "${provider}". Use "codex" or "anthropic".`);
  }
}

/** Local whisper.cpp transcription; requires WHISPER_MODEL to point at a ggml model file. */
export function createStt(env: Env = process.env): SttProvider {
  const model = env["WHISPER_MODEL"];
  if (!model) throw new Error("Set WHISPER_MODEL to a whisper.cpp model file to transcribe audio, or pass --text.");
  return new WhisperCppStt(model, env["WHISPER_CLI"] ?? "whisper-cli", env["WHISPER_LANGUAGE"] ?? "auto");
}
