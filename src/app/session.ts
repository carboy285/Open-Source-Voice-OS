import type { AppContext, ConfirmHandler, InjectorCommand, LlmProvider, SttProvider, TextInjector, ToolHost } from "../core/types.js";
import { appKind } from "../core/context.js";
import { runAgent } from "../modes/agent.js";
import { resolveUtterance } from "../modes/commands.js";
import { dictate } from "../modes/dictation.js";
import { editSelection } from "../modes/edit.js";

export type VoiceMode = "dictate" | "edit" | "agent";
export type UiState = "idle" | "listening" | "thinking" | "done" | "error";
export interface VoiceResult {
  id: string;
  at: number;
  mode: VoiceMode;
  transcript: string;
  text: string;
  status: "inserted" | "ready" | "failed" | "cancelled" | "completed";
  error?: string;
}
export interface Recorder {
  start(): Promise<void>;
  stop(signal?: AbortSignal): Promise<string>;
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
  /** Opaque identity of app, window, focused control and its contents. Fail closed if unavailable. */
  captureTarget?: () => Promise<string | undefined>;
  restoreTarget?: (target: string) => Promise<void>;
  /** Text of the focused field, when the user has opted in. Read in the background; never delays recording. */
  screenText?: () => Promise<string | undefined>;
  previewEdit?: (before: string, after: string, signal: AbortSignal) => Promise<boolean>;
  result?: (result: VoiceResult) => void;
  progress?: (message: string) => void;
  polishDictation?: boolean;
  cleanupMode?: "verbatim" | "clean" | "polished";
  vocabulary?: Record<string, string>;
  snippets?: Record<string, string>;
  voiceCommands?: boolean;
  minRecordingMs?: number;
  now?: () => number;
}

export class VoiceSession {
  private state: "idle" | "recording" | "processing" | "cancelling" = "idle";
  private mode: VoiceMode = "dictate";
  private startedAt = 0;
  private starting: Promise<void> = Promise.resolve();
  private controller = new AbortController();
  private target?: string;
  private context: AppContext = {};
  private selection = "";
  private screen?: Promise<string | undefined>;
  private inserted = false;
  private undoTarget?: string;
  private queued?: string;
  private queuedRetry?: VoiceResult;
  private replay?: { text?: string; result?: VoiceResult };

  constructor(private readonly deps: SessionDeps) {}
  updateSettings(settings: Pick<SessionDeps, "cleanupMode" | "vocabulary" | "snippets" | "voiceCommands">): void {
    Object.assign(this.deps, settings);
  }
  get busy(): boolean { return this.state !== "idle"; }
  invalidateUndo(): void { this.inserted = false; }

  /** The next dictation hotkey inserts into the destination the user chooses. */
  queueInsertion(text: string): void {
    if (this.busy) throw new Error("Finish or cancel the current request first.");
    this.queued = text;
    this.deps.status("done", "Focus the destination, then press the dictation hotkey to insert.");
  }

  queueRetry(result: VoiceResult): void {
    if (this.busy) throw new Error("Finish or cancel the current request first.");
    if (result.mode === "agent") throw new Error("Use agent follow-up for a new request.");
    this.queuedRetry = result;
    this.deps.status("done", `Focus the destination${result.mode === "edit" ? " and select text" : ""}, then press the ${result.mode} hotkey to retry.`);
  }

  press(mode: VoiceMode): void {
    if (this.busy) return;
    this.replay = this.queued !== undefined && mode === "dictate" ? { text: this.queued }
      : this.queuedRetry?.mode === mode ? { result: this.queuedRetry } : undefined;
    if (this.replay) { this.queued = undefined; this.queuedRetry = undefined; }
    this.state = "recording";
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.mode = mode;
    this.startedAt = (this.deps.now ?? Date.now)();
    this.starting = (async () => {
      await this.capture(mode);
      signal.throwIfAborted();
      if (!this.replay) await this.deps.recorder.start();
    })().catch((error: unknown) => {
      if (!signal.aborted) {
        this.state = "idle";
        this.deps.status("error", message(error));
      }
    });
    this.deps.status("listening", undefined, mode);
  }

  async cancel(): Promise<void> {
    this.queued = undefined;
    this.queuedRetry = undefined;
    if (!this.busy) return;
    this.controller.abort();
    this.invalidateUndo();
    if (this.state === "recording") {
      this.state = "cancelling";
      await this.starting;
      await this.deps.recorder.cancel().catch(() => undefined);
      this.state = "idle";
    }
    this.deps.status(this.state === "processing" ? "thinking" : "idle", this.state === "processing" ? "Cancelling…" : undefined);
  }

  async release(): Promise<void> {
    if (this.state !== "recording") return;
    this.state = "processing";
    const heldMs = (this.deps.now ?? Date.now)() - this.startedAt;
    await this.starting;
    if (this.state !== "processing") return;
    // Cancelling while the microphone was still starting leaves it recording; nothing else will stop it.
    if (this.controller.signal.aborted) await this.deps.recorder.cancel().catch(() => undefined);
    await this.execute(async (signal) => {
      if (this.replay) {
        if (this.replay.result) await this.run(this.replay.result.transcript, signal);
        else { await this.insert(this.replay.text!, false, signal); this.deps.status("done", "Inserted."); }
        this.replay = undefined;
        return;
      }
      if (heldMs < (this.deps.minRecordingMs ?? 300)) {
        await this.deps.recorder.cancel();
        this.deps.status("idle");
        return;
      }
      this.stage("Transcribing…");
      const wav = await this.deps.recorder.stop(signal);
      const transcript = (await this.deps.stt.transcribe(wav, signal)).trim();
      signal.throwIfAborted();
      if (!transcript) throw new Error("I didn't catch that.");
      await this.run(transcript, signal);
    });
  }

  async followUp(text: string): Promise<void> { await this.process("agent", text); }

  private async process(mode: VoiceMode, transcript: string): Promise<void> {
    if (this.busy) throw new Error("Finish or cancel the current request first.");
    this.state = "processing";
    this.mode = mode;
    this.controller = new AbortController();
    await this.execute(async (signal) => {
      await this.capture(mode);
      signal.throwIfAborted();
      await this.run(transcript, signal);
    });
  }

  private async capture(mode: VoiceMode): Promise<void> {
    const appName = await this.deps.frontmostApp?.();
    this.context = { appName, kind: appKind(appName) };
    this.screen = this.deps.screenText?.().catch(() => undefined);
    this.target = await this.deps.captureTarget?.();
    this.selection = mode === "edit" ? await this.deps.injector.getSelection() : "";
  }

  private async execute(work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const signal = this.controller.signal;
    try { signal.throwIfAborted(); await work(signal); }
    catch (error) { if (!signal.aborted) this.deps.status("error", message(error), this.mode); }
    finally { this.state = "idle"; if (signal.aborted) this.deps.status("idle"); }
  }

  private stage(text: string): void {
    this.deps.status("thinking", text, this.mode);
    this.deps.progress?.(text);
  }

  private async checkTarget(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.deps.captureTarget && (!this.target || await this.deps.captureTarget() !== this.target)) {
      throw new Error("The destination changed. Your result is saved in Results; copy it or choose Reinsert.");
    }
    signal.throwIfAborted();
  }

  private async insert(text: string, edit: boolean, signal: AbortSignal): Promise<void> {
    await this.checkTarget(signal);
    if (edit && await this.deps.injector.getSelection() !== this.selection) {
      throw new Error("The selection changed. Your edit is saved in Results.");
    }
    signal.throwIfAborted();
    this.stage("Inserting…");
    await (edit ? this.deps.injector.replaceSelection(text) : this.deps.injector.insert(text));
    this.inserted = true;
    this.undoTarget = await this.deps.captureTarget?.();
  }

  private async run(transcript: string, signal: AbortSignal): Promise<void> {
    const { llm, status } = this.deps;
    const entry: VoiceResult = {
      id: crypto.randomUUID(), at: Date.now(), mode: this.mode, transcript, text: "", status: "failed",
    };
    const model: LlmProvider = { complete: (request) => {
      signal.throwIfAborted();
      return llm.complete({ ...request, signal });
    } };
    // Compute output first. All desktop mutations pass through the guarded insertion below.
    let record = true;
    const output: TextInjector = {
      getSelection: async () => this.selection,
      insert: async (text) => { entry.text = text; },
      replaceSelection: async (text) => { entry.text = text; },
    };
    try {
      const screenText = await this.screen;
      signal.throwIfAborted();
      if (screenText) this.context.screenText = screenText;
      if (this.mode === "dictate") {
        const utterance = resolveUtterance(transcript, { snippets: this.deps.snippets, commands: this.deps.voiceCommands !== false });
        if (utterance.kind === "command") {
          await this.checkTarget(signal);
          await this.runCommand(utterance.command);
          record = false; // an action, not output: nothing to recover, and the overlay already reported it
          return;
        }
        if (utterance.kind === "snippet") entry.text = utterance.text;
        else {
          const mode = this.deps.cleanupMode ?? (this.deps.polishDictation ? "polished" : "clean");
          this.stage(mode === "polished" ? "Rewriting…" : "Cleaning up…");
          await dictate(utterance.text, output, this.context, { mode, vocabulary: this.deps.vocabulary, polish: mode === "polished" ? model : undefined });
        }
        signal.throwIfAborted();
        if (entry.text) await this.insert(entry.text, false, signal);
        entry.status = "inserted";
        status("done", utterance.kind === "snippet" ? `Inserted “${utterance.trigger}”.` : entry.text ? undefined : "Nothing to insert.");
      } else if (this.mode === "edit") {
        this.invalidateUndo();
        this.stage("Rewriting…");
        await editSelection(transcript, output, model, this.context);
        signal.throwIfAborted();
        entry.status = "ready";
        if (this.deps.previewEdit) {
          const approved = await this.deps.previewEdit(this.selection, entry.text, signal);
          signal.throwIfAborted();
          if (!approved) { status("done", "Edit saved without replacing the original."); return; }
          if (this.target) await this.deps.restoreTarget?.(this.target);
        }
        await this.insert(entry.text, true, signal);
        entry.status = "inserted";
        status("done");
      } else {
        this.invalidateUndo();
        this.stage("Planning…");
        const tools = await this.deps.tools();
        try {
          signal.throwIfAborted();
          const outcome = await runAgent(transcript, model, tools, this.deps.confirm, { context: this.context, signal, progress: (text) => this.stage(text) });
          signal.throwIfAborted();
          entry.text = outcome.reply;
          entry.status = "completed";
          status("done", outcome.reply, "agent");
        } finally { await tools.close?.(); }
      }
    } catch (error) {
      entry.status = signal.aborted ? "cancelled" : entry.text ? "ready" : "failed";
      entry.error = signal.aborted ? "Cancelled. An action already sent to a tool may still finish." : message(error);
      throw error;
    } finally { if (record) this.deps.result?.(entry); }
  }

  private async runCommand(command: InjectorCommand): Promise<void> {
    const { injector, status } = this.deps;
    if (!injector.command) { status("error", "Voice commands are not available here."); return; }
    if (command === "undo" && (!this.inserted || (this.deps.captureTarget && this.target !== this.undoTarget))) {
      status("error", "Nothing to scratch."); return;
    }
    await injector.command(command);
    this.inserted = false;
    status("done", command === "undo" ? "Scratched that." : "Selected all.");
  }
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
