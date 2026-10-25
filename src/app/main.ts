import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, screen, session, shell, systemPreferences, Tray } from "electron";
import { uIOhook, UiohookKey } from "uiohook-napi";
import { createLlm, createStt } from "../config.js";
import type { ConfirmHandler, SttProvider, ToolHost } from "../core/types.js";
import { loadMcpConfig, McpToolHost } from "../mcp/host.js";
import { codexAuth } from "../providers/codex.js";
import { WhisperServerStt } from "../providers/whisper.js";
import { AppConfig, configToEnv, parseAppConfig } from "./appConfig.js";
import { ResultHistory } from "./history.js";
import { HotkeyController } from "./hotkeys.js";
import { captureMacTarget, frontmostApp, MacInjector, playSystemSound, realExec, resolveMacPath, restoreMacTarget } from "./macos.js";
import { type Recorder, type UiState, VoiceSession } from "./session.js";
import { toWhisperWav } from "./wav.js";

const here = dirname(fileURLToPath(import.meta.url));
const asset = (name: string) => join(here, "assets", name);
app.setName("Open Source Voice OS");
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
let tray: Tray;
let recorderWindow: BrowserWindow;
let overlayWindow: BrowserWindow;
let panelWindow: BrowserWindow;
let overlayTimer: NodeJS.Timeout | undefined;
let overlayExpanded = false;
let overlayDisplay: Electron.Display | undefined;
const OVERLAY_WIDTH = 560;
let config: AppConfig;
let voice: VoiceSession;
let warmStt: WhisperServerStt | undefined;
const history = new ResultHistory();
let progress = "Ready";
let progressLog: string[] = [];
let approvals: Array<{ id: string; title: string; before?: string; detail: string }> = [];
const pendingApprovals = new Map<string, (allow: boolean) => void>();
const configPath = () => join(app.getPath("userData"), "config.json");

async function loadConfig(): Promise<AppConfig> {
  try { return parseAppConfig(await readFile(configPath(), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // Earlier Terminal launches used the npm package name for their settings directory.
      try { return parseAppConfig(await readFile(join(app.getPath("appData"), "open-source-voice-os", "config.json"), "utf8")); }
      catch (legacyError) {
        if ((legacyError as NodeJS.ErrnoException).code === "ENOENT") return parseAppConfig(undefined);
        throw legacyError;
      }
    }
    throw error;
  }
}
function secureWindow(options: Electron.BrowserWindowConstructorOptions): BrowserWindow {
  const window = new BrowserWindow({ ...options,
    webPreferences: { preload: asset("preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", event => event.preventDefault());
  return window;
}
function publishPanel() {
  panelWindow?.webContents.send("panel:update", {
    entries: history.list(), progress, progressLog, approvals,
    settings: { cleanupMode: config.cleanupMode ?? (config.polishDictation ? "polished" : "clean"),
      vocabulary: config.vocabulary, historyEnabled: config.historyEnabled,
      historyLimit: config.historyLimit, whisperBackend: config.whisperBackend },
  });
}
function openPanel(focus = true) {
  if (focus) panelWindow.show(); else panelWindow.showInactive();
  publishPanel();
}
/** The overlay hangs from the top edge of the display, so it reads as part of the notch. */
function placeOverlay(height?: number) {
  const { bounds, workArea } = overlayDisplay ?? screen.getPrimaryDisplay();
  overlayWindow.setBounds({ x: bounds.x + Math.round((bounds.width - OVERLAY_WIDTH) / 2), y: bounds.y,
    width: OVERLAY_WIDTH, height: height ?? overlayWindow.getBounds().height });
  return Math.max(0, workArea.y - bounds.y); // menu bar height: content stays below it and the hardware notch
}
/** Tools the agent ran for the current request, for the notch's "What I did" list. */
const ranTools = () => [...new Set(progressLog.filter(line => line.startsWith("Running ")).map(line => line.slice(8).replace(/…$/, "")))];
function dismissAfter(ms: number) {
  clearTimeout(overlayTimer);
  overlayTimer = setTimeout(() => showOverlay("idle", ""), ms);
}
/** `expanded` opens the notch with the full response and what was done; it stays until dismissed or read. */
function showOverlay(state: UiState, label: string, expanded = false) {
  clearTimeout(overlayTimer);
  overlayExpanded = expanded && state !== "idle";
  if (state === "idle") return overlayWindow.hide();
  // Open on the display you are working on. It stays there until the next state change.
  overlayDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const inset = placeOverlay();
  overlayWindow.setIgnoreMouseEvents(!overlayExpanded);
  overlayWindow.webContents.send("overlay:update", { state, label, inset, expanded: overlayExpanded, steps: overlayExpanded ? ranTools() : [] });
  overlayWindow.showInactive();
  if (overlayExpanded && config.notchSound) playSystemSound(state === "error" ? "error" : "done");
  if (state === "done" || state === "error") dismissAfter(overlayExpanded ? Math.min(45000, 10000 + label.length * 50) : Math.min(10000, 2500 + label.length * 40));
}
function wireOverlay() {
  const fromOverlay = (event: Electron.IpcMainEvent) => event.sender === overlayWindow.webContents;
  ipcMain.on("overlay:size", (event, height: unknown) => {
    if (fromOverlay(event) && typeof height === "number" && Number.isFinite(height)) placeOverlay(Math.min(600, Math.max(40, Math.round(height))));
  });
  // Reading takes time: hold the notch open while the pointer is on it.
  ipcMain.on("overlay:hover", (event, hovering: unknown) => {
    if (!fromOverlay(event) || !overlayExpanded) return;
    if (hovering === true) clearTimeout(overlayTimer); else dismissAfter(4000);
  });
  ipcMain.on("overlay:action", (event, name: unknown) => {
    if (!fromOverlay(event)) return;
    if (name === "open") openPanel();
    if (name === "open" || name === "dismiss") showOverlay("idle", "");
  });
}
const LABELS = { dictate: "Dictating…", edit: "Edit by voice…", agent: "Agent listening…" };
function onStatus(state: UiState, text?: string, mode?: keyof typeof LABELS) {
  const label = state === "listening" ? LABELS[mode ?? "dictate"]
    : state === "thinking" ? text ?? "Thinking…"
    : state === "idle" ? "Ready" : text || (state === "done" ? "Done" : "Error");
  progress = label;
  if (state === "listening") progressLog = [];
  publishPanel();
  showOverlay(state, label, mode === "agent" && (state === "done" || state === "error"));
  tray?.setTitle(state === "listening" ? "● Voice" : state === "thinking" ? "… Voice" : "Voice");
}

/** Every recorder operation is acknowledged, bounded, and tied to its originating window. */
function createRecorder(): Recorder {
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; cleanup: () => void }>();
  ipcMain.on("recorder:reply", (event, reply) => {
    if (event.sender !== recorderWindow.webContents || !reply || typeof reply.id !== "string") return;
    const request = pending.get(reply.id);
    if (!request) return;
    pending.delete(reply.id); clearTimeout(request.timer); request.cleanup();
    if (typeof reply.error === "string") request.reject(new Error(reply.error));
    else request.resolve(reply);
  });
  const request = (kind: string, signal?: AbortSignal): Promise<unknown> => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Cancelled")); return; }
    const id = randomUUID();
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      pending.delete(id); cleanup();
      reject(new Error("Microphone did not respond. Please try again."));
      recorderWindow.reload();
    }, 15000);
    const abort = () => {
      pending.delete(id); clearTimeout(timer); cleanup();
      recorderWindow.webContents.send("recorder:request", { id: randomUUID(), kind: "cancel" });
      reject(new Error("Cancelled"));
    };
    pending.set(id, { resolve, reject, timer, cleanup });
    signal?.addEventListener("abort", abort, { once: true });
    recorderWindow.webContents.send("recorder:request", { id, kind });
  });
  return {
    start: async () => {
      if (!await systemPreferences.askForMediaAccess("microphone")) {
        throw new Error("Enable Microphone access for Voice OS in System Settings → Privacy & Security.");
      }
      await request("start");
    },
    cancel: async () => { await request("cancel"); },
    stop: async signal => {
      const reply = await request("stop", signal) as { samples: Float32Array; sampleRate: number };
      if (!reply.samples || !Number.isFinite(reply.sampleRate) || reply.sampleRate < 8000 || reply.sampleRate > 192000) throw new Error("Invalid microphone audio.");
      const file = join(tmpdir(), `voiceos-${randomUUID()}.wav`);
      await writeFile(file, toWhisperWav(new Float32Array(reply.samples), reply.sampleRate), { mode: 0o600 });
      return file;
    },
  };
}
function createLocalStt(): SttProvider {
  return { transcribe: async (path, signal) => {
    try {
      const provider = config.whisperBackend === "server"
        ? warmStt ??= new WhisperServerStt(config.whisperModel ?? process.env["WHISPER_MODEL"] ?? "", config.whisperServerBinary)
        : createStt(configToEnv(config, process.env));
      return await provider.transcribe(path, signal);
    } finally { await unlink(path).catch(() => undefined); }
  } };
}
function approval(title: string, detail: string, signal?: AbortSignal, before?: string): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const id = randomUUID();
    const finish = (allow: boolean) => {
      pendingApprovals.delete(id);
      approvals = approvals.filter(item => item.id !== id);
      signal?.removeEventListener("abort", abort);
      publishPanel();
      resolve(allow);
    };
    const abort = () => finish(false);
    pendingApprovals.set(id, finish);
    approvals.push({ id, title, detail, before });
    signal?.addEventListener("abort", abort, { once: true });
    openPanel(false);
  });
}
const confirm: ConfirmHandler = async ({ tool, input }) => approval(`Allow ${tool}?`, JSON.stringify(input, null, 2));
async function openTools(): Promise<ToolHost> {
  if (!config.mcpConfig) return { list: async () => [], call: async () => "" };
  return McpToolHost.connect(await loadMcpConfig(config.mcpConfig));
}
function cancel() {
  if (overlayExpanded) showOverlay("idle", ""); // Escape also closes an open response
  for (const finish of [...pendingApprovals.values()]) finish(false);
  void voice?.cancel();
}
function startHotkeys() {
  const names = new Map<number, string>(Object.entries(UiohookKey).map(([name, code]) => [code as number, name]));
  const controller = new HotkeyController(config.hotkeys, {
    press: mode => voice.press(mode), release: () => voice.release(), cancel,
    invalidateUndo: () => voice.invalidateUndo(),
  });
  uIOhook.on("keydown", e => controller.handle({ type: "down", key: names.get(e.keycode) ?? String(e.keycode) }));
  uIOhook.on("keyup", e => controller.handle({ type: "up", key: names.get(e.keycode) ?? String(e.keycode) }));
  uIOhook.on("mousedown", () => voice.invalidateUndo());
  uIOhook.on("wheel", () => voice.invalidateUndo());
  uIOhook.start();
}
async function openConfig() {
  await mkdir(dirname(configPath()), { recursive: true });
  await writeFile(configPath(), JSON.stringify(config, null, 2), { flag: "wx" }).catch(() => undefined);
  await shell.openPath(configPath());
}
function buildTray() {
  tray = new Tray(nativeImage.createEmpty()); tray.setTitle("Voice");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Results & settings…", click: () => openPanel() },
    { label: `Hold ${config.hotkeys.dictate} to dictate · ${config.hotkeys.edit} to edit · ${config.hotkeys.agent} for agent`, enabled: false },
    { label: "Cancel current request (Escape)", click: cancel },
    { type: "separator" },
    { label: "Sign in with ChatGPT (Codex)…", click: async () => {
      const code = await codexAuth(config.codexBinary).login().catch(() => 1);
      void dialog.showMessageBox({ message: code === 0 ? "Signed in." : "Sign-in did not finish. Is Codex installed (npm i -g @openai/codex)?" });
    } },
    { label: "Check sign-in", click: async () => {
      const result = await codexAuth(config.codexBinary).status().catch((e: Error) => ({ loggedIn: false, detail: e.message }));
      void dialog.showMessageBox({ message: result.detail || (result.loggedIn ? "Logged in" : "Not logged in") });
    } },
    { label: "Open settings file…", click: () => void openConfig() },
    { type: "separator" }, { label: "Quit", role: "quit" },
  ]));
}
function wirePanel() {
  ipcMain.handle("panel:action", async (event, action: unknown, value: unknown) => {
    if (event.sender !== panelWindow.webContents) throw new Error("Unknown window.");
    try {
      if (action === "ready") publishPanel();
      else if (action === "cancel") cancel();
      else if (action === "clear") { history.clear(); progressLog = []; publishPanel(); }
      else if (action === "approve" && value && typeof value === "object") {
        const input = value as { id?: unknown; allow?: unknown };
        if (typeof input.id === "string" && typeof input.allow === "boolean") pendingApprovals.get(input.id)?.(input.allow);
      } else if (action === "followup" && typeof value === "string" && value.trim() && value.length <= 16000) {
        if (voice.busy) throw new Error("Finish or cancel the current request first.");
        progressLog = [];
        const last = history.list().find(entry => entry.mode === "agent" && entry.status === "completed");
        const prompt = last ? `Previous request: ${last.transcript.slice(-16000)}\nPrevious reply: ${last.text.slice(-16000)}\n\nFollow-up: ${value.trim()}` : value.trim();
        void voice.followUp(prompt);
      } else if (action === "settings" && value && typeof value === "object") {
        if (voice.busy) throw new Error("Finish or cancel the current request before changing settings.");
        const input = value as Record<string, unknown>;
        const next = AppConfig.parse({ ...config, cleanupMode: input.cleanupMode, vocabulary: input.vocabulary,
          historyEnabled: input.historyEnabled, historyLimit: input.historyLimit, whisperBackend: input.whisperBackend });
        await mkdir(dirname(configPath()), { recursive: true });
        await writeFile(configPath(), JSON.stringify(next, null, 2), { mode: 0o600 });
        config = next;
        warmStt?.close(); warmStt = undefined;
        history.configure(config.historyEnabled, config.historyLimit);
        voice.updateSettings({ cleanupMode: config.cleanupMode, vocabulary: config.vocabulary });
        publishPanel();
      } else if (["copy", "retry", "reinsert"].includes(String(action)) && typeof value === "string") {
        const entry = history.get(value);
        if (!entry) throw new Error("This result is no longer available.");
        if (action === "copy") clipboard.writeText(entry.text || entry.transcript);
        else {
          if (action === "retry") voice.queueRetry(entry);
          else {
            if (!entry.text) throw new Error("There is no output to insert yet. Use Retry.");
            voice.queueInsertion(entry.text);
          }
          panelWindow.hide();
        }
      }
      return { ok: true };
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  });
}
app.whenReady().then(async () => {
  if (!primaryInstance) return;
  app.dock?.hide();
  process.env["PATH"] = await resolveMacPath(process.env["PATH"] ?? "", homedir());
  config = await loadConfig().catch((error: Error) => {
    dialog.showErrorBox("Voice OS settings", `${configPath()}: ${error.message}`);
    return parseAppConfig(undefined);
  });
  history.configure(config.historyEnabled, config.historyLimit);
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => callback(permission === "media" && wc === recorderWindow?.webContents));
  recorderWindow = secureWindow({ show: false, width: 1, height: 1 });
  await recorderWindow.loadFile(asset("recorder.html"));
  overlayWindow = secureWindow({ width: OVERLAY_WIDTH, height: 80, show: false, frame: false, transparent: true,
    resizable: false, focusable: false, hasShadow: false, alwaysOnTop: true, enableLargerThanScreen: true });
  overlayWindow.setAlwaysOnTop(true, "screen-saver"); // above the menu bar, where the notch is
  overlayWindow.setIgnoreMouseEvents(true);
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  wireOverlay();
  await overlayWindow.loadFile(asset("overlay.html"));
  panelWindow = secureWindow({ show: false, width: 760, height: 780, minWidth: 560, minHeight: 500, title: "Voice OS — Results & settings", backgroundColor: "#17191f" });
  panelWindow.on("close", event => { event.preventDefault(); panelWindow.hide(); });
  wirePanel();
  await panelWindow.loadFile(asset("panel.html"));
  voice = new VoiceSession({
    recorder: createRecorder(), stt: createLocalStt(), injector: new MacInjector(realExec, 120, true),
    llm: { complete: request => createLlm(configToEnv(config, process.env)).complete(request) },
    tools: openTools, confirm, status: onStatus,
    frontmostApp: () => frontmostApp(realExec), captureTarget: () => captureMacTarget(realExec), restoreTarget: target => restoreMacTarget(target, realExec),
    previewEdit: (before, after, signal) => approval("Review voice edit", after, signal, before),
    result: entry => { history.add(entry); publishPanel(); if (entry.status === "ready" || (entry.status === "failed" && entry.mode !== "agent")) openPanel(false); },
    progress: text => { progressLog = [...progressLog, text].slice(-40); publishPanel(); },
    polishDictation: config.polishDictation, cleanupMode: config.cleanupMode, vocabulary: config.vocabulary,
    snippets: config.snippets, voiceCommands: config.voiceCommands,
  });
  buildTray();
  if (systemPreferences.isTrustedAccessibilityClient(false)) startHotkeys();
  else {
    progress = "Enable Accessibility and Input Monitoring for Open Source Voice OS in System Settings → Privacy & Security, then quit and reopen the app to enable hotkeys.";
  }
  if (!app.getLoginItemSettings().wasOpenedAtLogin) openPanel();
}).catch((error: Error) => { dialog.showErrorBox("Voice OS could not start", error.message); app.quit(); });
app.on("activate", () => { if (panelWindow) openPanel(); });
app.on("second-instance", () => { if (panelWindow) openPanel(); });
app.on("window-all-closed", () => {});
app.on("before-quit", () => { panelWindow?.removeAllListeners("close"); cancel(); warmStt?.close(); });
app.on("will-quit", () => uIOhook.stop());
