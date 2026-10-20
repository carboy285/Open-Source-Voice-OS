import { rmSync } from "node:fs";
import { AgentHub } from "../agents/hub.js";
import { ClaudeAdapter } from "../agents/claude.js";
import { CodexAdapter } from "../agents/codex.js";
import { OpenCodeAdapter } from "../agents/opencode.js";
import type { AgentAdapter, AgentSession } from "../agents/types.js";
import { ComposioHost, ComposioService, type ComposioEvent } from "../composio/service.js";
import { COMPOSIO_KEY } from "../composio/client.js";
import { builtinConnectors } from "../connectors/index.js";
import { randomUUID } from "node:crypto";
import { authorizeUrl, createPkce, exchangeCode, saveTokens, tokenKey, waitForRedirect } from "../connectors/oauth.js";
import { CompositeToolHost, ConnectorRegistry, type RegistryState } from "../connectors/registry.js";
import type { ConnectorContext } from "../connectors/types.js";
import { WEB_SEARCH_KEY } from "../connectors/web.js";
import { summarizeChanges, type Change, type ChangeCategory } from "../dictation/changes.js";
import { vocabularyHint } from "../dictation/dictionary.js";
import { CorrectionLearner } from "../dictation/learning.js";
import { categorize, type AppCategory } from "../dictation/tone.js";
import type { ApprovalUi } from "../gate/gate.js";
import { parseApprovalMode } from "../gate/safety.js";
import { resolveLocale, t, type Locale } from "../i18n/index.js";
import { forgetSecrets, loadConfig, type McpConfig } from "../mcp/config.js";
import { McpManager, type ConnectionFactory } from "../mcp/manager.js";
import { Conversation, type ChatSnapshot } from "../modes/conversation.js";
import { editSelection } from "../modes/edit.js";
import { processDictation } from "../modes/dictation.js";
import { AnthropicLlm } from "../providers/anthropic.js";
import { ChatGptSession } from "../providers/chatgpt-auth.js";
import { ChatGptCodexLlm } from "../providers/chatgpt-codex.js";
import { redactSecrets } from "./redact.js";
import { OpenAICompatibleLlm } from "../providers/openai-compatible.js";
import {
  LLM_PRESETS,
  STT_PRESETS,
  TTS_PRESETS,
  allProviderKeyNames,
  findLlmPreset,
  findSttPreset,
  findTtsPreset,
  llmKeyName,
  sttKeyName,
  ttsKeyName,
} from "../providers/catalog.js";
import { CloudStt } from "../providers/cloud-stt.js";
import { CloudTts, type Speech } from "../providers/cloud-tts.js";
import { WhisperCppStt } from "../providers/whisper-cpp.js";
import { ReminderScheduler } from "../reminders/scheduler.js";
import { localTimeZone } from "../reminders/time.js";
import { IndexedSecretStore, type SecretStore } from "../secrets/store.js";
import { Database } from "../storage/db.js";
import {
  CorrectionRepo,
  DictationHistoryRepo,
  DictionaryRepo,
  ReminderRepo,
  SettingsRepo,
  TaskRepo,
} from "../storage/repos.js";
import { TaskRunner, type TaskUpdate } from "../tasks/runner.js";
import { databasePath, mcpConfigPath, modelsDir } from "./paths.js";
import type { AppContext, Clock, ImageInput, LlmProvider, Pcm16Audio, SttProvider } from "./types.js";
import { systemClock } from "./types.js";
import { isLikelyInvented, isSilent, speechStats } from "../dictation/audio.js";
import { findModel } from "../models/catalog.js";
import { ModelManager } from "../models/manager.js";
import { ParakeetCppStt } from "../providers/parakeet-cpp.js";

import {
  PersonalizationError,
  correctionCommand,
  countSpoken,
  findShortcut,
  replaceSpokenText,
  selectProfile,
  translateDictation,
} from "../dictation/personalization.js";

export const LLM_KEY = "llm/apiKey";

/** What the shell reports from `context.capture`. */
export interface CapturedContext extends AppContext {
  /** The focused field is a password field. */
  secure?: boolean;
}

export type DictationState = "idle" | "listening" | "transcribing" | "cleaning" | "inserting" | "done" | "error";

export type CoreEvent =
  | { type: "state"; state: DictationState; step?: string; message?: string }
  | { type: "dictation.task" }
  | { type: "dictation.result"; text: string; changes: Change[]; summary: ChangeSummary[]; category: AppCategory }
  | ({ type: "task.update" } & TaskUpdate)
  | { type: "notify"; title: string; body: string; kind: "status" | "completion" | "warning" | "error" }
  | { type: "reminder.fire"; id: number; text: string; missed: boolean }
  | { type: "models.progress"; id: string; received: number; total?: number }
  | { type: "models.done"; id: string; ok: boolean; error?: string }
  | { type: "chatgpt.login"; state: "waiting" | "done" | "failed"; error?: string }
  | ComposioEvent
  | { type: "agents.update"; session: AgentSession }
  | ({ type: "conversation.update" } & ChatSnapshot);

export interface ChangeSummary {
  category: ChangeCategory;
  count: number;
  label: string;
}

/** Everything OS-specific the core asks the shell for. */
export interface ShellBridge {
  insertText(text: string): Promise<{ ok: boolean; method: string; reason?: string }>;
  captureContext(): Promise<CapturedContext>;
  replaceRecent?(expected: string, replacement: string): Promise<{ ok: boolean }>;
  secrets: SecretStore;
  approvals: ApprovalUi;
  emit(event: CoreEvent): void;
  /** Opens an https page in the user's browser. */
  openUrl?(url: string): Promise<void>;
  /**
   * Calls the Mac app's own Mail, Calendar and Reminders support. Present on macOS only; its presence adds the
   * Apple connectors.
   */
  native?(service: string, action: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface CoreOptions {
  bridge: ShellBridge;
  /** Database file; ":memory:" for tests. Defaults to the per-user data directory. */
  databasePath?: string;
  mcpConfigPath?: string;
  /** Downloaded speech models. Defaults to `models/` in the data directory. */
  modelsDir?: string;
  env?: NodeJS.ProcessEnv;
  clock?: Clock;
  /** Overrides for tests. */
  agentAdapters?: AgentAdapter[];
  stt?: SttProvider;
  llm?: LlmProvider;
  mcpFactory?: ConnectionFactory;
  fetch?: typeof fetch;
}

/** The headless core: pipelines, agent, connectors, MCP, storage and i18n, wired together. */
export class MurmurCore {
  db: Database;
  settings!: SettingsRepo;
  dictionary!: DictionaryRepo;
  history!: DictationHistoryRepo;
  chatgpt!: ChatGptSession;
  composio!: ComposioService;
  agents!: AgentHub;
  tasks!: TaskRepo;
  reminders!: ReminderRepo;
  learner!: CorrectionLearner;
  registry!: ConnectorRegistry;
  mcp: McpManager;
  models: ModelManager;
  runner!: TaskRunner;
  /** What the agent remembers between requests. */
  conversation!: Conversation;
  scheduler!: ReminderScheduler;
  readonly secrets: IndexedSecretStore;

  private readonly clock: Clock;
  private readonly dbPath: string;
  private readonly mcpPath: string;
  private pendingContext?: Promise<CapturedContext>;
  private dictationStarted = 0;
  private lastAudio?: Pcm16Audio;
  private recentDictation?: { text: string; at: number };
  private previewJob?: Promise<{ text: string }>;
  private previewGeneration = 0;
  private previewController?: AbortController;

  constructor(private readonly options: CoreOptions) {
    this.clock = options.clock ?? systemClock;
    this.dbPath = options.databasePath ?? databasePath(options.env);
    this.mcpPath = options.mcpConfigPath ?? mcpConfigPath(options.env);
    this.models = new ModelManager(options.modelsDir ?? modelsDir(options.env), options.fetch);
    this.db = new Database(this.dbPath);
    this.secrets = new IndexedSecretStore(options.bridge.secrets, {
      read: () => this.settings.get("secrets.index"),
      write: (keys) => this.settings.set("secrets.index", keys),
    });
    this.chatgpt = new ChatGptSession(this.secrets, options.fetch);
    this.mcp = new McpManager({
      secrets: this.secrets,
      factory: options.mcpFactory,
      callTimeoutMs: 60_000,
    });
    this.wire();
  }

  private wire(): void {
    const now = () => this.clock.now();
    this.settings = new SettingsRepo(this.db);
    this.dictionary = new DictionaryRepo(this.db, now);
    this.history = new DictationHistoryRepo(this.db, this.settings, now);
    this.tasks = new TaskRepo(this.db);
    this.reminders = new ReminderRepo(this.db);
    this.learner = new CorrectionLearner(
      new CorrectionRepo(this.db),
      (written) => this.dictionary.findByWritten(written) !== undefined,
      this.clock,
    );
    const state: RegistryState = {
      isEnabled: (id) => this.settings.get("connectors.enabled").includes(id),
      setEnabled: (id, on) => {
        const current = new Set(this.settings.get("connectors.enabled"));
        if (on) current.add(id);
        else current.delete(id);
        this.settings.set("connectors.enabled", [...current]);
      },
      settingsFor: (id) => this.settings.get("connectors.settings")[id] ?? {},
    };
    this.agents = new AgentHub({
      adapters: this.options.agentAdapters ?? [new CodexAdapter(), new ClaudeAdapter(), new OpenCodeAdapter()],
      approvals: this.options.bridge.approvals,
      emit: (event) => this.emit(event),
      isEnabled: (kind) => {
        const enabled: unknown = this.settings.get("agents.enabled");
        return Array.isArray(enabled) && enabled.includes(kind);
      },
      clock: this.clock,
      timeoutMs: () => this.settings.get("approval.timeoutMs"),
      recentFolders: {
        get: () => this.settings.get("agents.recentFolders"),
        set: (folders) => this.settings.set("agents.recentFolders", folders),
      },
    });
    this.registry = new ConnectorRegistry(state, (id) => this.connectorContext(id)).register(
      ...builtinConnectors(
        this.reminders,
        this.options.bridge.native,
        (text) => this.options.bridge.insertText(text),
        this.agents,
      ),
    );
    this.composio = new ComposioService({
      secrets: this.secrets,
      settings: this.settings,
      emit: (event) => this.emit(event),
      openUrl: async (url) => {
        if (!this.options.bridge.openUrl) throw new Error("Open this link to sign in: " + url);
        await this.options.bridge.openUrl(url);
      },
      fetch: this.options.fetch,
    });
    this.conversation = new Conversation(this.clock);
    this.conversation.onChange = () => this.emit({ type: "conversation.update", ...this.conversation.snapshot() });
    this.runner = new TaskRunner({
      conversation: this.conversation,
      llm: () => this.llm(),
      // Proxy so a reloaded MCP manager is picked up without rebuilding the runner.
      tools: new CompositeToolHost([
        this.registry,
        new ComposioHost(this.composio),
        { list: () => this.mcp.list(), call: (name, input) => this.mcp.call(name, input) },
      ]),
      approvals: this.options.bridge.approvals,
      approvalMode: () => parseApprovalMode(this.settings.get("approval.mode")),
      store: this.tasks,
      clock: this.clock,
      saveTranscripts: () => this.settings.get("history.saveTranscripts"),
      timeZone: localTimeZone,
      locale: () => (this.locale === "ja" ? "ja-JP" : "en-US"),
      limits: () => ({
        maxSteps: this.settings.get("agent.maxSteps"),
        maxWallMs: this.settings.get("agent.maxWallMs"),
        approvalTimeoutMs: this.settings.get("approval.timeoutMs"),
      }),
      onUpdate: (update) => this.emit({ type: "task.update", ...update }),
      notify: (status, reply) =>
        this.emit({
          type: "notify",
          title: this.t(
            status === "done"
              ? "notify.task_done"
              : status === "cancelled"
                ? "notify.task_cancelled"
                : "notify.task_failed",
          ),
          body: reply,
          kind: status === "done" ? "completion" : status === "cancelled" ? "status" : "error",
        }),
    });
    this.scheduler = new ReminderScheduler({
      store: this.reminders,
      clock: this.clock,
      onFire: ({ reminder, missed }) => {
        this.emit({ type: "reminder.fire", id: reminder.id, text: reminder.text, missed });
        this.emit({
          type: "notify",
          title: this.t("notify.reminder"),
          body: missed ? this.t("notify.reminder.missed", { text: reminder.text }) : reminder.text,
          kind: "status",
        });
      },
    });
  }

  /** Switches a new connector on once for people who already saved their own list. After that it is their call. */
  private offerNewConnectors(): void {
    const offered = new Set(this.settings.get("connectors.offered"));
    const enabled = new Set(this.settings.get("connectors.enabled"));
    for (const id of ["computer"]) {
      if (offered.has(id)) continue;
      enabled.add(id);
      offered.add(id);
    }
    this.settings.set("connectors.enabled", [...enabled]);
    this.settings.set("connectors.offered", [...offered]);
  }

  async start(): Promise<void> {
    this.offerNewConnectors();
    this.prune();
    this.scheduler.start();
    await this.reloadMcp();
  }

  async reloadMcp(): Promise<McpConfig> {
    const config = await loadConfig(this.mcpPath).catch(() => ({ servers: {} }));
    await this.mcp.close();
    this.mcp = new McpManager({
      secrets: this.secrets,
      factory: this.options.mcpFactory,
      callTimeoutMs: this.settings.get("mcp.callTimeoutMs"),
    });
    await this.mcp.start(config);
    return config;
  }

  prune(): void {
    this.history.prune();
    this.tasks.prune(this.clock.now() - Number(this.settings.get("tasks.retentionDays")) * 86_400_000);
  }

  get locale(): Locale {
    return resolveLocale(this.settings.get("ui.locale"));
  }

  t(key: string, params: Record<string, string | number> = {}): string {
    return t(key, params, this.locale);
  }

  private emit(event: CoreEvent): void {
    this.options.bridge.emit(event);
  }

  private connectorContext(id: string): ConnectorContext {
    return {
      settings: this.settings.get("connectors.settings")[id] ?? {},
      secrets: this.secrets,
      fetch: this.options.fetch ?? fetch,
      clock: this.clock,
      timeZone: localTimeZone(),
      locale: this.locale === "ja" ? "ja-JP" : "en-US",
    };
  }

  /** The configured model, or undefined when none is set up. */
  async llm(): Promise<LlmProvider | undefined> {
    if (this.options.llm) return this.options.llm;
    const provider = this.settings.get("llm.provider");
    const model = this.settings.get("llm.model");
    if (provider === "anthropic") {
      const apiKey = await this.secrets.get(LLM_KEY);
      return apiKey ? new AnthropicLlm({ apiKey, model }) : undefined;
    }
    if (provider === "chatgpt") {
      if (!(await this.chatgpt.status()).signedIn) return undefined;
      return new ChatGptCodexLlm({ session: this.chatgpt, model, fetch: this.options.fetch });
    }
    const preset = findLlmPreset(provider);
    if (preset) {
      const apiKey = await this.secrets.get(llmKeyName(preset.id));
      // A hosted service needs a key; one on this computer doesn't. The model starts as the preset's own.
      if (!preset.local && !apiKey) return undefined;
      const presetModel = model || preset.defaultModel;
      const customUrl = this.settings.get("llm.baseUrl");
      if (!presetModel) return undefined;
      return new OpenAICompatibleLlm({
        baseUrl: preset.local && customUrl ? customUrl : preset.chatUrl,
        model: presetModel,
        apiKey,
        vision: preset.vision === true || this.settings.get("llm.vision"),
        maxTokensParam: preset.maxTokensParam,
        plainSchemas: preset.plainSchemas,
        fetch: this.options.fetch,
      });
    }
    if (provider === "openai-compatible") {
      const baseUrl = this.settings.get("llm.baseUrl");
      if (!baseUrl || !model) return undefined;
      return new OpenAICompatibleLlm({
        baseUrl,
        model,
        apiKey: await this.secrets.get(LLM_KEY),
        vision: this.settings.get("llm.vision"),
        fetch: this.options.fetch,
      });
    }
    return undefined;
  }

  /**
   * NVIDIA Parakeet when a downloaded model is chosen (the default engine), whisper.cpp when picked in
   * Settings or when no Parakeet model is installed yet but a whisper model is set.
   */
  async stt(): Promise<SttProvider | undefined> {
    if (this.options.stt) return this.options.stt;
    // A hosted speech service, when the user chose one. Their recordings then go to that service.
    const cloud = findSttPreset(this.settings.get("stt.provider"));
    if (cloud) {
      const apiKey = await this.secrets.get(sttKeyName(cloud.id));
      // A server you run yourself (custom, NVIDIA's container) needs no key; a hosted one does.
      const ownServer = cloud.id === "custom" || cloud.id === "nvidia";
      const saved = this.settings.get("stt.baseUrl");
      const url = cloud.id === "custom" ? saved : ownServer ? saved || cloud.url : cloud.url;
      if (!url || (!ownServer && !apiKey)) return undefined;
      return new CloudStt({
        api: cloud.api,
        url,
        model: this.settings.get("stt.model.cloud") || cloud.defaultModel,
        apiKey,
        fetch: this.options.fetch,
      });
    }
    const engine = this.settings.get("stt.engine");
    if (engine === "parakeet") {
      const id = this.settings.get("stt.parakeetModel");
      const path = id ? this.models.path(id) : undefined;
      if (id && path && this.models.isInstalled(id)) {
        return new ParakeetCppStt({ binary: this.settings.get("stt.parakeetBinary") || "parakeet-cli", model: path });
      }
    }
    const model = this.settings.get("stt.model");
    if (!model) return undefined;
    return new WhisperCppStt({ binary: this.settings.get("stt.binary") || "whisper-cli", model });
  }

  /** Every service Murmur can use, for Settings to list. Keys are never part of it. */
  providerCatalog() {
    return {
      llm: LLM_PRESETS.map(({ id, name, defaultModel, keyUrl, local, vision }) => ({
        id,
        name,
        defaultModel,
        keyUrl,
        local: local === true,
        vision: vision === true,
      })),
      stt: STT_PRESETS.map(({ id, name, defaultModel, keyUrl, url }) => ({ id, name, defaultModel, keyUrl, url })),
      tts: TTS_PRESETS.map(({ id, name, defaultModel, defaultVoice, keyUrl, url }) => ({
        id,
        name,
        defaultModel,
        defaultVoice,
        keyUrl,
        url,
      })),
    };
  }

  /** The chosen hosted voice, or nothing when the Mac's own voices are in use. */
  async cloudTts(): Promise<CloudTts | undefined> {
    const preset = findTtsPreset(this.settings.get("tts.provider"));
    if (!preset) return undefined;
    const apiKey = await this.secrets.get(ttsKeyName(preset.id));
    const ownServer = preset.id === "custom";
    const url = ownServer ? this.settings.get("tts.baseUrl") : preset.url;
    if (!url || (!ownServer && !apiKey)) return undefined;
    return new CloudTts({
      api: preset.api,
      url,
      model: this.settings.get("tts.model") || preset.defaultModel,
      voice: this.settings.get("tts.cloudVoice") || preset.defaultVoice,
      apiKey,
      fetch: this.options.fetch,
    });
  }

  /** A spoken reply from the hosted voice. The shell plays it, and falls back to the Mac's voice if this fails. */
  async synthesize(text: string): Promise<{ audio: string; mediaType: string }> {
    const tts = await this.cloudTts();
    if (!tts) throw new Error("No hosted voice is set up.");
    const speech: Speech = await tts.synthesize(text);
    return { audio: speech.audio.toString("base64"), mediaType: speech.mediaType };
  }

  // Speech models

  /** Starts a download in the background; progress and the result arrive as events. */
  /** Starts the ChatGPT device-code sign-in. The shell shows the code; progress arrives as `chatgpt.login` events. */
  chatgptLogin() {
    return this.chatgpt.startLogin((event) => {
      if (event.state === "done") this.settings.set("llm.provider", "chatgpt");
      this.emit({ type: "chatgpt.login", ...event, ...(event.error ? { error: redactSecrets(event.error) } : {}) });
    });
  }

  chatgptStatus() {
    return this.chatgpt.status();
  }

  async chatgptLogout(): Promise<void> {
    await this.chatgpt.logout();
    if (this.settings.get("llm.provider") === "chatgpt") this.settings.set("llm.provider", "none");
  }

  downloadModel(id: string): void {
    if (!findModel(id)) throw new Error(`Unknown model: ${id}`);
    void this.models
      .download(id, (progress) => this.emit({ type: "models.progress", ...progress }))
      .then(() => {
        // The first model you download becomes the one Murmur uses.
        const current = this.settings.get("stt.parakeetModel");
        if (!current || !this.models.isInstalled(current)) this.useModel(id);
        this.emit({ type: "models.done", id, ok: true });
      })
      .catch((error: Error) => this.emit({ type: "models.done", id, ok: false, error: error.message }));
  }

  useModel(id: string): void {
    if (!this.models.isInstalled(id)) throw new Error("Download this model first.");
    this.settings.set("stt.parakeetModel", id);
    this.settings.set("stt.engine", "parakeet");
  }

  removeModel(id: string): void {
    this.models.cancel(id);
    this.models.remove(id);
    if (this.settings.get("stt.parakeetModel") === id) this.settings.set("stt.parakeetModel", "");
  }

  modelState() {
    return {
      engine: this.settings.get("stt.engine"),
      active: this.settings.get("stt.parakeetModel"),
      dir: this.models.dir,
      models: this.models.list().map((m) => ({ ...m, downloading: this.models.isDownloading(m.id) })),
    };
  }

  async status(): Promise<{ llm: boolean; stt: boolean; locale: Locale }> {
    return { llm: (await this.llm()) !== undefined, stt: (await this.stt()) !== undefined, locale: this.locale };
  }

  // Dictation

  /** Hotkey down: capture context now, while the user's app is still focused. */
  beginDictation(): void {
    this.previewController?.abort();
    this.previewGeneration++;
    this.dictationStarted = this.clock.now();
    this.pendingContext = this.options.bridge.captureContext().catch(() => ({}));
    this.emit({ type: "state", state: "listening" });
  }

  cancelDictation(): void {
    this.previewController?.abort();
    this.previewGeneration++;
    this.pendingContext = undefined;
    this.lastAudio = undefined;
    this.emit({ type: "state", state: "idle" });
  }

  /** Rolling local preview. Never inserts, polishes, stores text, or starts actions. */
  async previewDictation(audio?: Pcm16Audio): Promise<{ text: string }> {
    if (!audio || !this.settings.get("dictation.livePreview") || this.previewJob) return { text: "" };
    if (audio.sampleRate !== 16000 || audio.pcm.length > 16000 * 2 * 15) return { text: "" };
    const generation = this.previewGeneration;
    const controller = new AbortController();
    this.previewController = controller;
    const job = this.transcribe(audio, controller.signal)
      .then((result) => ({ text: generation === this.previewGeneration ? result.text : "" }))
      .catch(() => ({ text: "" }));
    this.previewJob = job;
    try {
      return await job;
    } finally {
      if (this.previewController === controller) this.previewController = undefined;
      if (this.previewJob === job) this.previewJob = undefined;
    }
  }

  /** Setup practice runs the real speech/cleanup pipeline without typing into another app. */
  async practiceDictation(input: { audio?: Pcm16Audio; transcript?: string }): Promise<{ text: string }> {
    const transcript = input.transcript ?? (input.audio ? (await this.transcribe(input.audio)).text : "");
    const result = await processDictation(transcript, {}, { dictionary: this.dictionary.list() });
    return { text: result.text };
  }

  private canCorrectRecent(from: string): boolean {
    const recent = this.recentDictation;
    return (
      Boolean(recent && this.options.bridge.replaceRecent) &&
      this.clock.now() - recent!.at <= 120000 &&
      countSpoken(recent!.text, from) === 1
    );
  }

  private async correctRecent(command: NonNullable<ReturnType<typeof correctionCommand>>): Promise<DictationOutcome> {
    const recent = this.recentDictation;
    if (!recent || this.clock.now() - recent.at > 120000 || !this.options.bridge.replaceRecent)
      throw new PersonalizationError(
        "voice.no_recent",
        "No recent dictation to change. Select text and use voice edit instead.",
      );
    const text = command.kind === "undo" ? "" : replaceSpokenText(recent.text, command.from, command.to);
    const result = await this.options.bridge.replaceRecent(recent.text, text);
    if (!result.ok)
      throw new PersonalizationError(
        "voice.moved",
        "The text or cursor has moved. Select the text and use voice edit instead.",
      );
    this.recentDictation = text ? { text, at: this.clock.now() } : undefined;
    this.emit({ type: "state", state: "done", message: this.t("voice.corrected") });
    return { text, changes: [], summary: [], category: "general" };
  }

  private async transcribe(audio: Pcm16Audio, signal?: AbortSignal): Promise<{ text: string; language?: string }> {
    const stt = await this.stt();
    if (!stt) throw new StepError("transcribing", this.t("error.no_stt"));
    // A preview that was cancelled while its engine was being set up never starts.
    if (signal?.aborted) throw new StepError("transcribing", "cancelled");
    const languages = this.settings.get("dictation.languages");
    // Silence makes whisper invent text ("Thank you."), so silent recordings never reach it.
    const stats = speechStats(audio);
    if (isSilent(stats)) return { text: "" };
    try {
      const result = await stt.transcribe(audio, {
        signal,
        prompt: vocabularyHint(this.dictionary.list()) || undefined,
        language: languages.length === 1 ? languages[0] : undefined,
      });
      return isLikelyInvented(result.text, stats) ? { text: "" } : result;
    } catch (error) {
      throw new StepError("transcribing", (error as Error).message);
    }
  }

  /** Hotkey up: transcribe, clean, insert and report. Audio is kept in memory only for a retry after a failed transcription. */
  async finishDictation(input: { audio?: Pcm16Audio; transcript?: string }): Promise<DictationOutcome> {
    this.previewController?.abort();
    this.previewGeneration++;
    await this.previewJob;
    const context = (await (this.pendingContext ??
      this.options.bridge.captureContext().catch(() => ({})))) as CapturedContext;
    this.pendingContext = undefined;
    const audio = input.audio ?? this.lastAudio;
    try {
      let transcript = input.transcript;
      let language: string | undefined;
      if (transcript === undefined) {
        if (!audio) throw new StepError("transcribing", this.t("report.didnt_catch"));
        this.lastAudio = audio;
        this.emit({ type: "state", state: "transcribing" });
        ({ text: transcript, language } = await this.transcribe(audio));
      }

      if (context.secure) {
        this.lastAudio = undefined;
        this.emit({ type: "notify", title: this.t("app.name"), body: this.t("report.secure_field"), kind: "warning" });
        this.emit({ type: "state", state: "idle" });
        return { text: "", changes: [], summary: [], category: "general", refused: "secure" };
      }
      const command = correctionCommand(transcript);
      // "Change the meeting to Thursday" is also an ordinary sentence. It is only a correction when there is a recent
      // dictation that contains exactly that phrase once; otherwise it is typed like any other dictation.
      if (command && (command.kind === "undo" || this.canCorrectRecent(command.from))) {
        this.lastAudio = undefined;
        return await this.correctRecent(command);
      }
      const shortcut = findShortcut(transcript, this.settings.get("voice.shortcuts"));
      if (shortcut?.kind === "task") {
        this.lastAudio = undefined;
        this.emit({ type: "dictation.task" });
        await this.startTask({ transcript: shortcut.content, context });
        return { text: "", changes: [], summary: [], category: "general", empty: true };
      }
      this.emit({ type: "state", state: "cleaning" });
      const llm = await this.llm();
      const profile = selectProfile(
        context,
        this.settings.get("writing.profiles"),
        this.settings.get("writing.activeProfile"),
      );
      const result = shortcut
        ? { text: shortcut.content, changes: [], appliedIds: [], category: categorize(context) }
        : await processDictation(transcript, context, {
            dictionary: this.dictionary.list(),
            spokenPunctuation: this.settings.get("dictation.spokenPunctuation"),
            language,
            polish: llm,
            writingInstructions: profile?.instructions,
            categoryOverrides: this.settings.get("tone.overrides") as Record<string, AppCategory>,
            toneDisabled: this.settings.get("tone.disabled") as AppCategory[],
          });
      if (result.text && this.settings.get("dictation.outputMode") === "translate") {
        result.text = await translateDictation(result.text, this.settings.get("dictation.targetLanguage"), llm);
      }
      this.dictionary.recordUses(result.appliedIds);

      if (!result.text) {
        this.lastAudio = undefined;
        this.emit({ type: "state", state: "done", message: this.t("report.didnt_catch") });
        return { text: "", changes: [], summary: [], category: result.category, empty: true };
      }

      this.lastAudio = undefined;
      this.emit({ type: "state", state: "inserting" });
      const inserted = await this.options.bridge
        .insertText(result.text)
        .catch((): { ok: boolean; method: string; reason?: string } => ({ ok: false, method: "none" }));
      this.recentDictation = inserted.ok ? { text: result.text, at: this.clock.now() } : undefined;
      const notPlaced = !inserted.ok && inserted.reason !== "secure";
      if (notPlaced) {
        this.emit({ type: "notify", title: this.t("app.name"), body: this.t("report.copied"), kind: "warning" });
      }
      const durationMs = audio
        ? (audio.pcm.byteLength / 2 / audio.sampleRate) * 1000
        : this.clock.now() - this.dictationStarted;
      this.history.record({ category: result.category, text: result.text, durationMs });
      const summary = this.summarize(result.changes);
      this.emit({
        type: "dictation.result",
        text: result.text,
        changes: result.changes,
        summary,
        category: result.category,
      });
      // A failed insert must be visible in the app itself, not only in a notification that may be switched off.
      if (notPlaced) this.emit({ type: "state", state: "error", step: "inserting", message: this.t("report.copied") });
      else this.emit({ type: "state", state: "done" });
      return { text: result.text, changes: result.changes, summary, category: result.category, inserted };
    } catch (error) {
      const step = error instanceof StepError ? error.step : "cleaning";
      const message = error instanceof PersonalizationError ? this.t(error.key) : (error as Error).message;
      this.emit({ type: "state", state: "error", step, message });
      if (error instanceof PersonalizationError) throw new StepError(step, message);
      throw error;
    }
  }

  summarize(changes: Change[]): ChangeSummary[] {
    const counts = summarizeChanges(changes);
    return (Object.entries(counts) as Array<[ChangeCategory, number]>).map(([category, count]) => ({
      category,
      count,
      label: this.t(`report.${category}`, {
        count,
        word: changes.find((c) => c.category === category)?.after ?? "",
      }),
    }));
  }

  /** A correction the shell saw within 30 s of inserting text. A repeated one becomes a dictionary entry, with Undo. */
  observeCorrection(inserted: string, corrected: string): { entryId: number; summary: ChangeSummary[] } | undefined {
    this.learner.enabled = this.settings.get("dictation.learning");
    const suggestion = this.learner.observe(inserted, corrected);
    if (!suggestion) return undefined;
    const entry = this.dictionary.add({ written: suggestion.written, spoken: [suggestion.spoken], source: "learned" });
    const summary = this.summarize([suggestion.change]);
    this.emit({ type: "dictation.result", text: "", changes: [suggestion.change], summary, category: "general" });
    return { entryId: entry.id, summary };
  }

  // Voice edit

  async runEdit(input: {
    audio?: Pcm16Audio;
    transcript?: string;
    /** The app and selection captured before a typing box took focus. */
    context?: CapturedContext;
  }): Promise<{ text: string }> {
    const llm = await this.llm();
    if (!llm) throw new Error(this.t("agent.no_llm"));
    const instruction = input.transcript ?? (input.audio ? (await this.transcribe(input.audio)).text : "");
    const context =
      input.context ?? ((await (this.pendingContext ?? this.options.bridge.captureContext())) as CapturedContext);
    this.pendingContext = undefined;
    const bridge = this.options.bridge;
    const text = await editSelection(
      instruction,
      {
        insert: async (t) => void (await bridge.insertText(t)),
        getSelection: async () => context.selection ?? "",
        replaceSelection: async (t) => void (await bridge.insertText(t)),
      },
      llm,
    );
    this.emit({ type: "state", state: "done" });
    return { text };
  }

  // Agent

  async startTask(input: {
    transcript?: string;
    audio?: Pcm16Audio;
    context?: CapturedContext;
    /** A picture of what the user circled or is looking at. Dropped when the model can't see images. */
    images?: ImageInput[];
  }): Promise<{ taskId: string }> {
    const transcript = input.transcript ?? (input.audio ? (await this.transcribe(input.audio)).text : "");
    if (!transcript.trim()) throw new Error(this.t("report.didnt_catch"));
    const context =
      input.context ??
      ((await (this.pendingContext ?? this.options.bridge.captureContext().catch(() => ({})))) as CapturedContext);
    this.pendingContext = undefined;
    // Only a model that can see gets the picture. The others still get the text read from it (circledText).
    const images = input.images?.length && (await this.llm())?.supportsImages ? input.images.slice(0, 2) : undefined;
    const { taskId } = this.runner.start(
      transcript,
      {
        ...context,
        kind: categorize(context, this.settings.get("tone.overrides") as Record<string, AppCategory>),
        ...(input.images?.length ? { picture: context.picture ?? "window" } : {}),
      },
      images,
    );
    return { taskId };
  }

  // Connectors

  static readonly OAUTH_PORT = 53682;

  /** Runs the OAuth PKCE flow for a connector with the user's own client ID. `open` shows the consent page. */
  async authorizeConnector(id: string, open: (url: string) => Promise<void>): Promise<void> {
    const connector = this.registry.get(id);
    if (!connector || connector.auth.type !== "oauth2-pkce") throw new Error(`${id} does not use OAuth.`);
    const clientId = this.settings.get("connectors.settings")[id]?.clientId;
    if (typeof clientId !== "string" || !clientId) throw new Error(this.t("settings.connectors.client_id_missing"));
    const config = {
      authorizeUrl: connector.auth.authorizeUrl,
      tokenUrl: connector.auth.tokenUrl,
      clientId,
      scopes: connector.auth.scopes,
      redirectUri: `http://127.0.0.1:${MurmurCore.OAUTH_PORT}/callback`,
      extraParams: connector.auth.extraParams,
    };
    const pkce = createPkce();
    const state = randomUUID();
    const redirect = waitForRedirect(MurmurCore.OAUTH_PORT, state);
    await open(authorizeUrl(config, pkce, state));
    const { code } = await redirect;
    const tokens = await exchangeCode(config, code, pkce.verifier, this.options.fetch ?? fetch, this.clock.now());
    await saveTokens(this.secrets, id, tokens);
  }

  // Data

  /** Removes the database, Murmur's keychain entries and the MCP config, then starts fresh. */
  async deleteAll(): Promise<void> {
    this.recentDictation = undefined;
    this.previewController?.abort();
    this.previewGeneration++;
    await this.previewJob;
    const indexed = this.settings.get("secrets.index");
    const config = await loadConfig(this.mcpPath).catch(() => ({ servers: {} }));
    const known = [
      LLM_KEY,
      WEB_SEARCH_KEY,
      COMPOSIO_KEY,
      ...allProviderKeyNames(),
      ...this.registry.catalog().map((c) => tokenKey(c.id)),
    ];
    for (const key of new Set([...indexed, ...known])) await this.options.bridge.secrets.delete(key).catch(() => {});
    for (const server of Object.values(config.servers))
      await forgetSecrets(server, this.options.bridge.secrets).catch(() => {});
    this.scheduler.stop();
    await this.mcp.close();
    rmSync(this.mcpPath, { force: true });
    this.db.destroy();
    this.db = new Database(this.dbPath);
    this.wire();
    await this.start();
  }

  async close(): Promise<void> {
    await this.agents.close();
    this.scheduler.stop();
    await this.mcp.close();
    this.db.close();
  }
}

export interface DictationOutcome {
  text: string;
  changes: Change[];
  summary: ChangeSummary[];
  category: AppCategory;
  inserted?: { ok: boolean; method: string; reason?: string };
  empty?: boolean;
  refused?: "secure";
}

export class StepError extends Error {
  constructor(
    readonly step: "transcribing" | "cleaning" | "inserting",
    message: string,
  ) {
    super(message);
  }
}
