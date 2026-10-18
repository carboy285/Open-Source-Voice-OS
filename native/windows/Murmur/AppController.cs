using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Threading;
using Microsoft.Win32;

namespace Murmur
{
    /// <summary>Owns the core connection, the hotkey, the microphone and every window. Runs on the UI thread.</summary>
    internal sealed class AppController
    {
        public readonly CoreClient Core;
        public readonly HotkeyMonitor Hotkey = new();
        public readonly AudioCapture Audio = new();

        public ShellState State { get; private set; } = ShellState.Starting;
        public HotkeyAction Action { get; private set; } = HotkeyAction.Dictate;
        public List<ReportItem> Report { get; private set; } = new();
        public string? ReportMessage { get; private set; }
        public List<Preview> Approvals { get; } = new();
        public Dictionary<string, TaskInfo> Tasks { get; } = new();
        public List<TaskInfo> History { get; private set; } = new();
        public List<string> Recent { get; private set; } = new();
        public JsonObject Settings { get; private set; } = new();
        public List<ConnectorInfo> Connectors { get; private set; } = new();
        public JsonArray McpServers { get; private set; } = new();
        public bool LlmReady { get; private set; }
        public string? Notice { get; private set; }
        public string HotkeyName => HotkeyMonitor.Name(Hotkey.KeyCode);
        public bool SoundOn => Settings.Bool("sound.enabled", true);

        private readonly Dispatcher dispatcher;
        private readonly IndicatorWindow indicator;
        private readonly DimWindow dim = new();
        private readonly ApprovalWindow approval;
        private readonly SidePanelWindow panel;
        private readonly Tray tray;
        private SettingsWindow? settingsWindow;

        // ChatGPT sign-in, as the Settings screen shows it.
        public bool ChatGptSignedIn { get; private set; }
        public string ChatGptEmail { get; private set; } = "";
        public string ChatGptCode { get; private set; } = "";
        public string ChatGptUrl { get; private set; } = "";
        public bool ChatGptWaiting { get; private set; }
        public string ChatGptError { get; private set; } = "";
        public bool ComposioHasKey { get; private set; }
        public List<JsonObject> ComposioApps { get; private set; } = new();
        public string ComposioConnecting { get; private set; } = "";
        public string ComposioError { get; private set; } = "";
        public bool ComposioLoading { get; private set; }
        private OnboardingWindow? onboarding;
        private readonly DispatcherTimer reportTimer = new();
        private DateTime pressStarted;
        private double restartDelay = 1;

        public AppController(Dispatcher dispatcher)
        {
            this.dispatcher = dispatcher;
            Core = new CoreClient(dispatcher);
            indicator = new IndicatorWindow(this);
            approval = new ApprovalWindow(this, dim);
            panel = new SidePanelWindow(this);
            tray = new Tray(this);
            reportTimer.Tick += (_, _) => { reportTimer.Stop(); FinishReport(); };
        }

        // Startup

        public void Start()
        {
            RegisterHandlers();
            Core.Notification += OnNotification;
            Core.Exited += _ =>
            {
                Notice = L.T("error.core_stopped");
                SetState(ShellState.Error);
                var delay = TimeSpan.FromSeconds(restartDelay);
                restartDelay = Math.Min(restartDelay * 2, 60);
                var timer = new DispatcherTimer { Interval = delay };
                timer.Tick += (_, _) => { timer.Stop(); StartCore(); };
                timer.Start();
            };
            StartCore();
            Audio.Level += level => dispatcher.BeginInvoke(() => indicator.SetLevel(level));
            Hotkey.Down += HotkeyDown;
            Hotkey.Up += HotkeyUp;
            Hotkey.Escape += CancelListening;
            Hotkey.Start();
            if (!Permissions.MicrophoneAllowed || Registry.GetValue(Permissions.AppKey, "Onboarded", null) == null) ShowOnboarding();
        }

        private void StartCore()
        {
            SetState(ShellState.Starting);
            try
            {
                Core.Start();
            }
            catch (Exception error)
            {
                Notice = error.Message;
                SetState(ShellState.Error);
            }
        }

        private void RegisterHandlers()
        {
            Core.Handle("text.insert", async p =>
            {
                var (ok, method) = await TextInserter.Insert(p.Str("text"));
                return new JsonObject { ["ok"] = ok, ["method"] = method };
            });
            Core.Handle("context.capture", async _ => await ContextCapture.Capture());
            Core.Handle("secret.get", p => Task.FromResult<JsonNode?>(new JsonObject { ["value"] = CredentialStore.Get(p.Str("key")) }));
            Core.Handle("secret.set", p =>
            {
                if (!CredentialStore.Set(p.Str("key"), p.Str("value"))) throw new InvalidOperationException("Credential Manager write failed");
                return Task.FromResult<JsonNode?>(new JsonObject { ["ok"] = true });
            });
            Core.Handle("secret.delete", p =>
            {
                CredentialStore.Delete(p.Str("key"));
                return Task.FromResult<JsonNode?>(new JsonObject { ["ok"] = true });
            });
            Core.Handle("url.open", p =>
            {
                var url = p.Str("url");
                if (!url.StartsWith("https://", StringComparison.Ordinal)) throw new InvalidOperationException("Only https links can be opened");
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
                return Task.FromResult<JsonNode?>(new JsonObject { ["ok"] = true });
            });
        }

        private async void CoreReady()
        {
            restartDelay = 1;
            Notice = null;
            try
            {
                var locale = Registry.GetValue(Permissions.AppKey, "Locale", "system") as string ?? "system";
                await LoadStrings(locale);
                var hello = await Core.Request("core.hello", new JsonObject { ["shell"] = "windows" });
                LlmReady = hello.Bool("llm");
                SetState(ShellState.Idle);
                await RefreshSettings();
                RefreshRecent();
                RefreshConnectors();
            }
            catch (Exception error)
            {
                Notice = error.Message;
            }
        }

        private async Task LoadStrings(string locale)
        {
            var result = await Core.Request("i18n.strings", new JsonObject { ["locale"] = locale });
            if (result?["strings"] is JsonObject strings) L.Load(strings, result.Str("locale", "en"));
            tray.Refresh();
        }

        public void SetState(ShellState next)
        {
            State = next;
            indicator.Refresh();
            tray.Refresh();
        }

        // Hotkey

        private void HotkeyDown(HotkeyAction action)
        {
            if (State == ShellState.Starting) return;
            Action = action;
            pressStarted = DateTime.Now;
            reportTimer.Stop();
            indicator.HideCard();
            SetState(ShellState.Listening);
            indicator.ShowCapsule();
            Sound.Play(true, SoundOn);
            try
            {
                Audio.Start();
            }
            catch (Exception)
            {
                ShowMessage(L.T("error.no_mic"), ShellState.Error, 8);
                return;
            }
            Core.Send("dictation.start");
        }

        private async void HotkeyUp()
        {
            if (State != ShellState.Listening) return;
            var pcm = Audio.Stop();
            Sound.Play(false, SoundOn);
            if ((DateTime.Now - pressStarted).TotalMilliseconds < 300)
            {
                CancelListening();
                return;
            }
            var audio = new JsonObject { ["audio"] = Convert.ToBase64String(pcm), ["sampleRate"] = 16000 };
            SetState(Action == HotkeyAction.Agent ? ShellState.Agent : ShellState.Transcribing);
            try
            {
                switch (Action)
                {
                    case HotkeyAction.Dictate:
                        await Core.Request("dictation.stop", audio);
                        break;
                    case HotkeyAction.Edit:
                        await Core.Request("edit.run", audio);
                        FinishQuietly();
                        break;
                    case HotkeyAction.Agent:
                        await Core.Request("agent.run", audio);
                        break;
                }
            }
            catch (Exception error)
            {
                ShowMessage(error.Message, ShellState.Error, 8);
            }
        }

        public void CancelListening()
        {
            Audio.Stop();
            Core.Send("dictation.cancel");
            SetState(ShellState.Idle);
            indicator.HideAll();
        }

        public async void RetryDictation()
        {
            indicator.HideCard();
            SetState(ShellState.Transcribing);
            try { await Core.Request("dictation.retry"); }
            catch (Exception error) { ShowMessage(error.Message, ShellState.Error, 8); }
        }

        private void FinishQuietly()
        {
            SetState(ShellState.Idle);
            indicator.HideAll();
        }

        private void ShowMessage(string message, ShellState state, double seconds)
        {
            Report = new List<ReportItem>();
            ReportMessage = message;
            SetState(state);
            ShowReport(seconds);
        }

        private void ShowReport(double seconds = 6)
        {
            indicator.ShowCapsule();
            indicator.ShowCard();
            reportTimer.Stop();
            reportTimer.Interval = TimeSpan.FromSeconds(seconds);
            reportTimer.Start();
        }

        public void DismissReport()
        {
            reportTimer.Stop();
            FinishReport();
        }

        private void FinishReport()
        {
            if (State == ShellState.Listening) return;
            SetState(Tasks.Values.Any(t => t.IsActive) ? ShellState.Agent : ShellState.Idle);
            indicator.HideAll();
        }

        // Core notifications

        private void OnNotification(string method, JsonObject p)
        {
            switch (method)
            {
                case "core.ready":
                    CoreReady();
                    break;
                case "state":
                    var raw = p.Str("state");
                    if (!Enum.TryParse<ShellState>(raw, true, out var next) || next == ShellState.Listening) return;
                    if (Action == HotkeyAction.Agent && next == ShellState.Done) return;
                    if (next == ShellState.Done && p.Str("message").Length > 0) ShowMessage(p.Str("message"), next, 3);
                    else if (next == ShellState.Error) ShowMessage(p.Str("message"), next, 8);
                    else if (next == ShellState.Idle) FinishQuietly();
                    else SetState(next);
                    break;
                case "dictation.result":
                    Report = (p["summary"] as JsonArray ?? new JsonArray()).Select(s => new ReportItem { Category = s.Str("category"), Count = s.Int("count"), Label = s.Str("label") }).ToList();
                    ReportMessage = null;
                    if (p.Str("text").Length > 0) RefreshRecent();
                    if (Report.Count == 0) FinishQuietly();
                    else
                    {
                        SetState(ShellState.Done);
                        ShowReport();
                    }
                    break;
                case "task.update":
                    var info = TaskInfo.From(p);
                    Tasks.TryGetValue(info.Id, out var previous);
                    if (previous != null) info.StartedAt = previous.StartedAt;
                    Tasks[info.Id] = info;
                    if (info.Long && previous?.Long != true)
                    {
                        indicator.HideAll();
                        ShowPanel();
                    }
                    if (!info.IsActive)
                    {
                        if (!info.Long) ShowMessage(info.Reply, ShellState.Done, Math.Max(6, info.Reply.Length / 20.0));
                        else if (!Tasks.Values.Any(t => t.IsActive)) SetState(ShellState.Idle);
                        RefreshHistory();
                    }
                    if (panel.IsOpen) panel.Refresh();
                    break;
                case "approval.request":
                    var preview = Preview.From(p["preview"]);
                    if (preview == null) return;
                    var index = Approvals.FindIndex(a => a.CallId == preview.CallId);
                    if (index >= 0) Approvals[index] = preview;
                    else Approvals.Add(preview);
                    ShowApproval();
                    break;
                case "approval.dismiss":
                    Approvals.RemoveAll(a => a.CallId == p.Str("callId"));
                    ShowApproval();
                    break;
                case "notify":
                    tray.Balloon(p.Str("title", "Murmur"), p.Str("body"));
                    break;
                case "chatgpt.login":
                    if (p.Str("state") == "done")
                    {
                        ChatGptWaiting = false;
                        ChatGptCode = "";
                        ChatGptError = "";
                        _ = RefreshChatGpt();
                    }
                    else if (p.Str("state") == "failed")
                    {
                        ChatGptWaiting = false;
                        ChatGptCode = "";
                        ChatGptError = p.Str("error", "unknown error");
                        settingsWindow?.Rebuild();
                    }
                    break;
                case "composio.connect":
                    if (p.Str("state") == "waiting")
                    {
                        ComposioConnecting = p.Str("toolkit");
                        ComposioError = "";
                    }
                    else if (p.Str("state") == "done")
                    {
                        ComposioConnecting = "";
                        ComposioError = "";
                        _ = RefreshComposioApps();
                    }
                    else if (p.Str("state") == "failed")
                    {
                        ComposioConnecting = "";
                        ComposioError = p.Str("error", "unknown error");
                    }
                    settingsWindow?.Rebuild();
                    break;
                case "reminder.fire":
                    new ReminderToast(this, p.Int("id"), p.Str("text"), p.Bool("missed")).Present();
                    break;
            }
        }

        // Approval

        public void ShowApproval()
        {
            if (panel.IsOpen) panel.Refresh();
            var first = Approvals.FirstOrDefault();
            if (first == null)
            {
                approval.Dismiss();
                dim.Uncover();
                return;
            }
            dim.Cover();
            approval.Present(first, indicator.IsVisible ? indicator.Origin : tray.Origin);
        }

        public void RespondApproval(Preview preview, string decision, JsonObject? input)
        {
            var p = new JsonObject { ["callId"] = preview.CallId, ["decision"] = decision };
            if (input != null) p["input"] = input;
            Core.Send("approval.respond", p);
        }

        // Panel and history

        public void ShowPanel()
        {
            RefreshHistory();
            panel.Open();
        }

        public void HidePanel() => panel.SlideOut();

        public async void RefreshHistory(string query = "")
        {
            try
            {
                var result = await Core.Request("task.list", new JsonObject { ["query"] = query, ["limit"] = 50 });
                History = (result?["tasks"] as JsonArray ?? new JsonArray()).Select(TaskInfo.From).ToList();
                if (panel.IsOpen) panel.Refresh();
            }
            catch (CoreException) { }
        }

        public void CancelTask(string id) => Core.Send("task.cancel", new JsonObject { ["taskId"] = id });

        public async void RunAgain(string id)
        {
            try { await Core.Request("task.runAgain", new JsonObject { ["taskId"] = id }); }
            catch (CoreException error) { tray.Balloon(L.T("app.name"), error.Message); }
        }

        public async void RefreshRecent()
        {
            try
            {
                var result = await Core.Request("history.list", new JsonObject { ["limit"] = 5 });
                Recent = (result?["items"] as JsonArray ?? new JsonArray()).Select(item =>
                {
                    var text = item.Str("transcript");
                    return text.Length > 0 ? (text.Length > 60 ? text[..60] + "…" : text) : L.Count("menu.recent.words", item.Int("wordCount"));
                }).ToList();
                tray.Refresh();
            }
            catch (CoreException) { }
        }

        // Settings

        public async Task RefreshSettings()
        {
            var result = await Core.Request("settings.get");
            Settings = result?["values"] as JsonObject ?? new JsonObject();
            Hotkey.ToggleMode = Settings.Bool("dictation.toggleMode");
        }

        public async void SetSetting(string key, JsonNode? value, Action<JsonNode?>? then = null)
        {
            Settings[key] = value?.DeepClone();
            if (key == "dictation.toggleMode") Hotkey.ToggleMode = value?.GetValue<bool>() ?? false;
            try
            {
                var reply = await Core.Request("settings.set", new JsonObject { ["key"] = key, ["value"] = value?.DeepClone() });
                then?.Invoke(reply);
                var status = await Core.Request("status");
                LlmReady = status.Bool("llm");
            }
            catch (CoreException error)
            {
                Notice = error.Message;
            }
        }

        public async void SetLocale(string locale)
        {
            Registry.SetValue(Permissions.AppKey, "Locale", locale);
            SetSetting("ui.locale", locale);
            await LoadStrings(locale);
        }

        public async void RefreshConnectors(Action? done = null)
        {
            try
            {
                var result = await Core.Request("connectors.list");
                Connectors = (result?["connectors"] as JsonArray ?? new JsonArray()).Select(c => new ConnectorInfo
                {
                    Id = c.Str("id"),
                    Name = c.Str("name"),
                    Description = c.Str("description"),
                    Icon = c.Str("icon"),
                    Skeleton = c.Str("status") == "skeleton",
                    Enabled = c.Bool("enabled"),
                    Auth = c.Str("auth", "none"),
                }).ToList();
                McpServers = result?["mcp"]?.DeepClone() as JsonArray ?? new JsonArray();
                done?.Invoke();
            }
            catch (CoreException) { }
        }

        public void SetConnector(string id, bool enabled) => Core.Send(enabled ? "connectors.enable" : "connectors.disable", new JsonObject { ["id"] = id });

        public void ConfigureConnector(string id, JsonObject values) => Core.Send("connectors.configure", new JsonObject { ["id"] = id, ["settings"] = values });

        public async void Connect(string id)
        {
            try { await Core.Request("connectors.authorize", new JsonObject { ["id"] = id }, 330000); }
            catch (CoreException error) { tray.Balloon(L.T("app.name"), error.Message); }
        }

        public async Task RefreshChatGpt()
        {
            try
            {
                var status = await Core.Request("chatgpt.status");
                ChatGptSignedIn = status.Bool("signedIn");
                ChatGptEmail = status.Str("email");
                await RefreshSettings();
                var hello = await Core.Request("core.hello", new JsonObject { ["shell"] = "windows" });
                LlmReady = hello.Bool("llm");
            }
            catch (CoreException) { }
            settingsWindow?.Rebuild();
        }

        /// Asks the core for a code, shows it, and opens OpenAI's page where it is entered.
        public async void StartChatGptLogin()
        {
            ChatGptError = "";
            ChatGptWaiting = true;
            settingsWindow?.Rebuild();
            try
            {
                var started = await Core.Request("chatgpt.login.start");
                ChatGptCode = started.Str("userCode");
                ChatGptUrl = started.Str("url");
                OpenChatGptPage();
            }
            catch (CoreException error)
            {
                ChatGptWaiting = false;
                ChatGptError = error.Message;
            }
            settingsWindow?.Rebuild();
        }

        public void OpenChatGptPage()
        {
            if (ChatGptUrl.StartsWith("https://", StringComparison.Ordinal))
                Process.Start(new ProcessStartInfo(ChatGptUrl) { UseShellExecute = true });
        }

        public void CancelChatGptLogin()
        {
            Core.Send("chatgpt.login.cancel");
            ChatGptWaiting = false;
            ChatGptCode = "";
            settingsWindow?.Rebuild();
        }

        public async void SignOutChatGpt()
        {
            try { await Core.Request("chatgpt.logout"); }
            catch (CoreException) { }
            await RefreshChatGpt();
        }

        public async Task RefreshComposio()
        {
            try
            {
                var status = await Core.Request("composio.status");
                ComposioHasKey = status.Bool("hasKey");
            }
            catch (CoreException) { return; }
            if (ComposioHasKey) await RefreshComposioApps();
            else
            {
                ComposioApps = new List<JsonObject>();
                settingsWindow?.Rebuild();
            }
        }

        public async Task RefreshComposioApps(string query = "")
        {
            ComposioLoading = true;
            settingsWindow?.Rebuild();
            try
            {
                var reply = await Core.Request("composio.apps", new JsonObject { ["query"] = query }, 60000);
                var apps = (reply?["apps"] as JsonArray)?.OfType<JsonObject>().ToList() ?? new List<JsonObject>();
                ComposioApps = apps.Where(a => a.Bool("connected")).Concat(apps.Where(a => !a.Bool("connected"))).ToList();
            }
            catch (CoreException error) { ComposioError = error.Message; }
            ComposioLoading = false;
            settingsWindow?.Rebuild();
        }

        public async void SaveComposioKey(string key)
        {
            ComposioError = "";
            try
            {
                await Core.Request("composio.setKey", new JsonObject { ["key"] = key }, 40000);
                ComposioHasKey = true;
                await RefreshComposioApps();
            }
            catch (CoreException error)
            {
                ComposioError = error.Message;
                settingsWindow?.Rebuild();
            }
        }

        public async void RemoveComposioKey()
        {
            try { await Core.Request("composio.removeKey"); }
            catch (CoreException) { }
            ComposioHasKey = false;
            ComposioApps = new List<JsonObject>();
            settingsWindow?.Rebuild();
        }

        public async void ConnectComposioApp(string slug)
        {
            ComposioError = "";
            ComposioConnecting = slug;
            settingsWindow?.Rebuild();
            try { await Core.Request("composio.connect", new JsonObject { ["app"] = slug }); }
            catch (CoreException error)
            {
                ComposioConnecting = "";
                ComposioError = error.Message;
                settingsWindow?.Rebuild();
            }
        }

        public async void DisconnectComposioApp(string slug)
        {
            try { await Core.Request("composio.disconnect", new JsonObject { ["app"] = slug }, 40000); }
            catch (CoreException error) { ComposioError = error.Message; }
            await RefreshComposioApps();
        }

        public void ConfigureComposioApp(string slug, bool? enabled = null, bool? readOnly = null)
        {
            var app = ComposioApps.FirstOrDefault(a => a.Str("slug") == slug);
            var values = new JsonObject { ["app"] = slug };
            if (enabled.HasValue) { values["enabled"] = enabled.Value; if (app != null) app["enabled"] = enabled.Value; }
            if (readOnly.HasValue) { values["readOnly"] = readOnly.Value; if (app != null) app["readOnly"] = readOnly.Value; }
            Core.Send("composio.configure", values);
        }

        public void SaveApiKey(string key)
        {
            if (key.Length == 0) CredentialStore.Delete("llm/apiKey");
            else CredentialStore.Set("llm/apiKey", key);
            SetSetting("llm.provider", Settings.Str("llm.provider", "anthropic"));
        }

        public async void DeleteAllData()
        {
            try
            {
                await Core.Request("data.deleteAll", null, 30000);
                Registry.CurrentUser.DeleteSubKeyTree(@"Software\Murmur", false);
                await RefreshSettings();
                RefreshRecent();
                RefreshConnectors();
                History = new List<TaskInfo>();
            }
            catch (CoreException error)
            {
                tray.Balloon(L.T("app.name"), error.Message);
            }
        }

        public void ShowSettings()
        {
            RefreshConnectors(() => settingsWindow?.Rebuild());
            _ = RefreshChatGpt();
            _ = RefreshComposio();
            settingsWindow ??= new SettingsWindow(this);
            settingsWindow.Rebuild();
            settingsWindow.Show();
            settingsWindow.Activate();
        }

        public void ShowOnboarding()
        {
            onboarding ??= new OnboardingWindow(this);
            onboarding.Show();
            onboarding.Activate();
        }

        public void Quit()
        {
            Hotkey.Dispose();
            Core.Stop();
            tray.Dispose();
            Application.Current.Shutdown();
        }
    }
}
