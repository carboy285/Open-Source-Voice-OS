import { z } from "zod";

const KeyName = z.string().min(1);

export const AppConfig = z.object({
  llm: z.enum(["codex", "anthropic"]).default("codex"),
  model: z.string().optional(),
  codexBinary: z.string().default("codex"),
  whisperModel: z.string().optional(),
  whisperBinary: z.string().default("whisper-cli"),
  /** Path to an MCP servers file (see voiceos.mcp.example.json) that gives agent mode its tools. */
  mcpConfig: z.string().optional(),
  /** Refine dictation with the model. Slower because each call starts a Codex run. */
  polishDictation: z.boolean().default(false),
  /** Saved snippets: the phrase the user says maps to the text that is typed. */
  snippets: z.record(z.string(), z.string()).default({}),
  /** Resolve built-in commands such as "scratch that" and "select all" instead of dictating them. */
  voiceCommands: z.boolean().default(true),
  /** Hold-to-talk keys, by uiohook key name. Defaults avoid keys that type characters. */
  hotkeys: z
    .object({
      dictate: KeyName.default("AltRight"),
      edit: KeyName.default("MetaRight"),
      agent: KeyName.default("CtrlRight"),
    })
    .default({ dictate: "AltRight", edit: "MetaRight", agent: "CtrlRight" }),
});
export type AppConfig = z.infer<typeof AppConfig>;

export function parseAppConfig(json: string | undefined): AppConfig {
  return AppConfig.parse(json ? JSON.parse(json) : {});
}

/** Environment understood by createLlm/createStt, derived from the config. */
export function configToEnv(config: AppConfig, base: Record<string, string | undefined> = {}) {
  return {
    ...base,
    VOICEOS_LLM: config.llm,
    VOICEOS_MODEL: config.model ?? base["VOICEOS_MODEL"],
    VOICEOS_CODEX_BIN: config.codexBinary,
    WHISPER_MODEL: config.whisperModel ?? base["WHISPER_MODEL"],
    WHISPER_CLI: config.whisperBinary,
  };
}
