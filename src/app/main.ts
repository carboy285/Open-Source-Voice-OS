import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, session, shell, systemPreferences, Tray } from "electron";
import { uIOhook, UiohookKey } from "uiohook-napi";
import { createLlm, createStt } from "../config.js";
import type { ConfirmHandler, SttProvider, ToolHost } from "../core/types.js";
import { loadMcpConfig, McpToolHost } from "../mcp/host.js";
import { codexAuth } from "../providers/codex.js";
import { AppConfig, configToEnv, parseAppConfig } from "./appConfig.js";
import { HotkeyController } from "./hotkeys.js";
import { frontmostApp, MacInjector, realExec, resolveMacPath } from "./macos.js";
import { type Recorder, type UiState, VoiceSession } from "./session.js";
import { toWhisperWav } from "./wav.js";

const here = dirname(fileURLToPath(import.meta.url));
const asset = (name: string) => join(here, "assets", name);

if (!app.requestSingleInstanceLock()) app.quit();

let tray: Tray;
let recorderWindow: BrowserWindow;
let overlayWindow: BrowserWindow;
let overlayTimer: NodeJS.Timeout | undefined;
let config: AppConfig;
let voice: VoiceSession;

const configPath = () => join(app.getPath("userData"), "config.json");

async function loadConfig(): Promise<AppConfig> {
  try {
    return parseAppConfig(await readFile(configPath(), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return parseAppConfig(undefined);
    throw error;
  }
}

function secureWindow(options: Electron.BrowserWindowConstructorOptions): BrowserWindow {
  return new BrowserWindow({
    ...options,
    webPreferences: { preload: asset("preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
}

function showOverlay(state: UiState, label: string) {
  clearTimeout(overlayTimer);
  overlayWindow.webContents.send("overlay:update", { state, label });
  if (state === "idle") return overlayWindow.hide();
  overlayWindow.showInactive();
  if (state === "done" || state === "error") {
    overlayTimer = setTimeout(() => showOverlay("idle", ""), 2500 + label.length * 40);
  }
}

const LABELS: Record<string, string> = { dictate: "Dictating…", edit: "Edit by voice…", agent: "Agent listening…" };

function onStatus(state: UiState, text?: string, mode?: keyof typeof LABELS) {
  const label =
    state === "listening" ? (LABELS[mode ?? "dictate"] ?? "Listening…")
    : state === "thinking" ? "Thinking…"
    : state === "idle" ? ""
    : (text ?? (state === "done" ? "Done" : "Error"));
  showOverlay(state, label);
  tray?.setTitle(state === "listening" ? "● Voice" : state === "thinking" ? "… Voice" : "Voice");
}

/** Recording happens in a hidden page that owns the microphone; audio comes back over IPC. */
function createRecorder(): Recorder {
  let waiting: { resolve: (path: string) => void; reject: (error: Error) => void } | undefined;
  ipcMain.on("recorder:audio", async (_event, payload: { samples: Float32Array; sampleRate: number }) => {
    const request = waiting;
    waiting = undefined;
    if (!request) return;
    try {
      const file = join(tmpdir(), `voiceos-${Date.now()}.wav`);
      await writeFile(file, toWhisperWav(new Float32Array(payload.samples), payload.sampleRate), { mode: 0o600 });
      request.resolve(file);
    } catch (error) {
      request.reject(error as Error);
    }
  });
  ipcMain.on("recorder:error", (_event, message: string) => {
    const error = new Error(`Microphone error: ${message}`);
    if (waiting) {
      waiting.reject(error);
      waiting = undefined;
    } else {
      void voice.cancel().finally(() => onStatus("error", error.message));
    }
  });
  return {
    start: async () => void recorderWindow.webContents.send("recorder:start"),
    stop: () =>
      new Promise<string>((resolve, reject) => {
        waiting = { resolve, reject };
        recorderWindow.webContents.send("recorder:stop");
      }),
    cancel: async () => void recorderWindow.webContents.send("recorder:cancel"),
  };
}

/** Whisper reads the recording; it is deleted straight after, whether or not transcription worked. */
function createLocalStt(): SttProvider {
  return {
    transcribe: async (path) => {
      try {
        return await createStt(configToEnv(config, process.env)).transcribe(path);
      } finally {
        await unlink(path).catch(() => undefined);
      }
    },
  };
}

const confirm: ConfirmHandler = async ({ tool, input }) => {
  const { response } = await dialog.showMessageBox({
    type: "question",
    buttons: ["Allow", "Deny"],
    defaultId: 1,
    cancelId: 1,
    message: `Allow "${tool}"?`,
    detail: JSON.stringify(input, null, 2).slice(0, 1500),
  });
  return response === 0;
};

async function openTools(): Promise<ToolHost> {
  if (!config.mcpConfig) return { list: async () => [], call: async () => "" };
  return McpToolHost.connect(await loadMcpConfig(config.mcpConfig));
}

function startHotkeys() {
  const names = new Map<number, string>(Object.entries(UiohookKey).map(([name, code]) => [code as number, name]));
  const controller = new HotkeyController(config.hotkeys, {
    press: (mode) => voice.press(mode),
    release: () => voice.release(),
    cancel: () => voice.cancel(),
  });
  uIOhook.on("keydown", (e) => controller.handle({ type: "down", key: names.get(e.keycode) ?? String(e.keycode) }));
  uIOhook.on("keyup", (e) => controller.handle({ type: "up", key: names.get(e.keycode) ?? String(e.keycode) }));
  uIOhook.start();
}

async function openConfig() {
  await mkdir(dirname(configPath()), { recursive: true });
  await writeFile(configPath(), JSON.stringify(config, null, 2), { flag: "wx" }).catch(() => undefined);
  await shell.openPath(configPath());
}

function buildTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle("Voice");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Hold Right ⌥ to dictate · Right ⌘ to edit · Right ⌃ for agent", enabled: false },
      { type: "separator" },
      {
        label: "Sign in with ChatGPT (Codex)…",
        click: async () => {
          const code = await codexAuth(config.codexBinary).login().catch(() => 1);
          void dialog.showMessageBox({ message: code === 0 ? "Signed in." : "Sign-in did not finish. Is Codex installed (npm i -g @openai/codex)?" });
        },
      },
      {
        label: "Check sign-in",
        click: async () => {
          const result = await codexAuth(config.codexBinary).status().catch((e: Error) => ({ loggedIn: false, detail: e.message }));
          void dialog.showMessageBox({ message: result.detail || (result.loggedIn ? "Logged in" : "Not logged in") });
        },
      },
      { label: "Open settings file…", click: () => void openConfig() },
      { type: "separator" },
      { label: "Quit", role: "quit" },
    ]),
  );
}

app.whenReady().then(async () => {
  app.dock?.hide();
  process.env["PATH"] = await resolveMacPath(process.env["PATH"] ?? "", homedir());
  config = await loadConfig().catch((error: Error) => {
    void dialog.showErrorBox("Voice OS settings", `${configPath()}: ${error.message}`);
    return parseAppConfig(undefined);
  });

  // Prompts macOS for the two permissions the app needs (Accessibility and Input Monitoring are granted in Settings).
  await systemPreferences.askForMediaAccess("microphone");
  systemPreferences.isTrustedAccessibilityClient(true);

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === "media"));

  recorderWindow = secureWindow({ show: false, width: 1, height: 1 });
  await recorderWindow.loadFile(asset("recorder.html"));

  const { width } = screen.getPrimaryDisplay().workAreaSize;
  overlayWindow = secureWindow({
    width: 500, height: 120, x: Math.round((width - 500) / 2), y: 0,
    show: false, frame: false, transparent: true, resizable: false, focusable: false, hasShadow: false, alwaysOnTop: true,
  });
  overlayWindow.setIgnoreMouseEvents(true);
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  await overlayWindow.loadFile(asset("overlay.html"));

  voice = new VoiceSession({
    recorder: createRecorder(),
    stt: createLocalStt(),
    injector: new MacInjector(realExec),
    llm: { complete: (request) => createLlm(configToEnv(config, process.env)).complete(request) },
    tools: openTools,
    confirm,
    status: onStatus,
    frontmostApp: () => frontmostApp(realExec),
    polishDictation: config.polishDictation,
    dictationOptions: { spokenPunctuation: config.spokenPunctuation, vocabulary: config.vocabulary },
  });

  buildTray();
  startHotkeys();
});

app.on("window-all-closed", () => {
  /* keep running in the menu bar */
});
app.on("will-quit", () => uIOhook.stop());
