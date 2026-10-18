import type { AppContext, ConfirmHandler, LlmProvider, SttProvider, TextInjector, ToolHost } from "../core/types.js";
import { runAgent } from "../modes/agent.js";
import { dictate, type CleanupOptions } from "../modes/dictation.js";
import { editSelection } from "../modes/edit.js";

export type VoiceMode = "dictate" | "edit" | "agent";
export type UiState = "idle" | "listening" | "thinking" | "done" | "error";

export interface Recorder {
  start(): Promise<void>;
  /** Stops recording and returns the path of a 16 kHz mono WAV file. */
  stop(): Promise<string>;
  cancel(): Promise<void>;
}

export interface SessionDeps {
  recorder: Recorder;
  stt: SttProvider;
  injector: TextInjector;
  llm: LlmProvider;
  tools: () => Promise<ToolHost>;
  confirm: ConfirmHandler;
  status: (state: UiState, text?: string, mode?: VoiceMode) => void;
  frontmostApp?: () => Promise<string | undefined>;
  /** Refine dictation with the model (slower, nicer). */
  polishDictation?: boolean;
  dictationOptions?: CleanupOptions;
  /** Recordings shorter than this are treated as accidental taps. */
  minRecordingMs?: number;
  now?: () => number;
}

/** Push-to-talk controller: press starts recording, release transcribes and runs the chosen mode. */
export class VoiceSession {
  private state: "idle" | "recording" | "processing" | "cancelling" = "idle";
  private mode: VoiceMode = "dictate";
  private startedAt = 0;
  private starting: Promise<void> = Promise.resolve();

  constructor(private readonly deps: SessionDeps) {}

  get busy(): boolean {
    return this.state !== "idle";
  }

  press(mode: VoiceMode): void {
    if (this.state !== "idle") return;
    this.state = "recording";
    this.mode = mode;
    this.startedAt = (this.deps.now ?? Date.now)();
    this.starting = this.deps.recorder.start().catch((error: unknown) => {
      if (this.state === "cancelling") return;
      this.state = "idle";
      this.deps.status("error", `Microphone unavailable: ${message(error)}`);
    });
    this.deps.status("listening", undefined, mode);
  }

  /** Abandon the recording, e.g. because the hotkey was part of a normal key combination. */
  async cancel(): Promise<void> {
    if (this.state !== "recording") return;
    this.state = "cancelling";
    try {
      await this.starting;
      await this.deps.recorder.cancel().catch(() => undefined);
      this.deps.status("idle");
    } finally {
      this.state = "idle";
    }
  }

  async release(): Promise<void> {
    if (this.state !== "recording") return;
    this.state = "processing";
    const heldMs = (this.deps.now ?? Date.now)() - this.startedAt;
    await this.starting;
    if (this.state !== "processing") return; // the microphone failed to start
    try {
      if (heldMs < (this.deps.minRecordingMs ?? 300)) {
        await this.deps.recorder.cancel();
        this.deps.status("idle");
        return;
      }
      this.deps.status("thinking", undefined, this.mode);
      const wav = await this.deps.recorder.stop();
      const transcript = (await this.deps.stt.transcribe(wav)).trim();
      if (!transcript) {
        this.deps.status("error", "I didn't catch that.");
        return;
      }
      await this.run(this.mode, transcript);
    } catch (error) {
      this.deps.status("error", message(error));
    } finally {
      this.state = "idle";
    }
  }

  private async run(mode: VoiceMode, transcript: string): Promise<void> {
    const { injector, llm, status } = this.deps;
    const context: AppContext = { appName: await this.deps.frontmostApp?.() };
    if (mode === "dictate") {
      const text = await dictate(transcript, injector, context, {
        ...this.deps.dictationOptions,
        polish: this.deps.polishDictation ? llm : undefined,
      });
      status("done", text ? undefined : "Nothing to insert.");
    } else if (mode === "edit") {
      await editSelection(transcript, injector, llm);
      status("done");
    } else {
      const tools = await this.deps.tools();
      try {
        const outcome = await runAgent(transcript, llm, tools, this.deps.confirm, { context });
        status("done", outcome.reply);
      } finally {
        await tools.close?.();
      }
    }
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
