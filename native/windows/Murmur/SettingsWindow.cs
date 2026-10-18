using System;
using System.ComponentModel;
using System.Linq;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using Microsoft.Win32;

namespace Murmur
{
    internal sealed class SettingsWindow : Window
    {
        private readonly AppController app;
        private readonly TabControl tabs = new() { Margin = new Thickness(16, 40, 16, 16) };

        public SettingsWindow(AppController app)
        {
            this.app = app;
            Width = 640;
            Height = 560;
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            FontFamily = Theme.Font;
            FontSize = Theme.Body;
            Backdrop.Apply(this, transient: false, caption: true);
            Content = tabs;
            Closing += (_, e) => { e.Cancel = true; Hide(); };
        }

        public void Rebuild()
        {
            Title = L.T("settings.title");
            var selected = tabs.SelectedIndex;
            tabs.Items.Clear();
            tabs.Items.Add(Tab(L.T("settings.tab.general"), General()));
            tabs.Items.Add(Tab(L.T("settings.tab.dictation"), Dictation()));
            tabs.Items.Add(Tab(L.T("settings.tab.agent"), Agent()));
            tabs.Items.Add(Tab(L.T("settings.tab.connectors"), Connectors()));
            tabs.Items.Add(Tab(L.T("settings.tab.apps"), Apps()));
            tabs.Items.Add(Tab(L.T("settings.tab.privacy"), Privacy()));
            tabs.SelectedIndex = Math.Max(0, selected);
        }

        private static TabItem Tab(string header, UIElement content)
        {
            var item = new TabItem { Header = header, Content = new ScrollViewer { Content = content, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Padding = new Thickness(16) } };
            AutomationProperties.SetName(item, header);
            return item;
        }

        private bool Flag(string key, bool fallback = false) => app.Settings.Bool(key, fallback);
        private CheckBox Toggle(string label, string key, bool fallback = false) => Ui.Toggle(label, Flag(key, fallback), on => app.SetSetting(key, on));

        private UIElement General()
        {
            var language = new ComboBox { Width = 220, HorizontalAlignment = HorizontalAlignment.Left };
            AutomationProperties.SetName(language, L.T("settings.language"));
            var options = new[] { ("system", L.T("settings.language.system")), ("en", "English"), ("ja", "日本語") };
            foreach (var (_, label) in options) language.Items.Add(label);
            language.SelectedIndex = Math.Max(0, Array.FindIndex(options, o => o.Item1 == app.Settings.Str("ui.locale", "system")));
            language.SelectionChanged += (_, _) => { app.SetLocale(options[language.SelectedIndex].Item1); Rebuild(); };

            var updates = Ui.Toggle(L.T("settings.updates"), Registry.GetValue(Permissions.AppKey, "AutoUpdate", 1) is int u && u == 1,
                on => Registry.SetValue(Permissions.AppKey, "AutoUpdate", on ? 1 : 0));

            return Ui.Column(8,
                Ui.Text(L.T("settings.language"), Theme.Body, FontWeights.SemiBold),
                language,
                Toggle(L.T("settings.sound"), "sound.enabled", true),
                Ui.Toggle(L.T("settings.launch_at_login"), Permissions.LaunchAtLogin, on => Permissions.LaunchAtLogin = on),
                updates,
                Ui.Text(L.T("settings.hotkey.dictate") + ": " + app.HotkeyName, secondary: true),
                Ui.Text(L.T("settings.hotkey.agent") + ": " + app.HotkeyName + " + Shift", secondary: true),
                Ui.Text(L.T("settings.hotkey.edit") + ": " + app.HotkeyName + " + Ctrl", secondary: true));
        }

        private UIElement Dictation() => Ui.Column(8,
            Toggle(L.T("settings.toggle_mode"), "dictation.toggleMode"),
            Toggle(L.T("settings.spoken_punctuation"), "dictation.spokenPunctuation"),
            Toggle(L.T("settings.learning"), "dictation.learning", true),
            PathRow(L.T("settings.stt.binary"), "stt.binary"),
            PathRow(L.T("settings.stt.model"), "stt.model"));

        private UIElement PathRow(string label, string key)
        {
            var box = Ui.Input(app.Settings.Str(key), label);
            box.Width = 400;
            box.LostFocus += (_, _) => app.SetSetting(key, box.Text);
            var choose = Ui.Button(L.T("settings.stt.choose"), () =>
            {
                var dialog = new OpenFileDialog();
                if (dialog.ShowDialog(this) == true)
                {
                    box.Text = dialog.FileName;
                    app.SetSetting(key, dialog.FileName);
                }
            });
            return Ui.Column(4, Ui.Text(label, Theme.Body, FontWeights.SemiBold), Ui.Row(box, choose));
        }

        private UIElement Agent()
        {
            var provider = app.Settings.Str("llm.provider", "none");
            var options = new[] { ("none", L.T("settings.llm.none")), ("anthropic", L.T("settings.llm.anthropic")), ("openai-compatible", L.T("settings.llm.openai")), ("chatgpt", L.T("settings.llm.chatgpt")) };
            var picker = new ComboBox { Width = 280, HorizontalAlignment = HorizontalAlignment.Left };
            AutomationProperties.SetName(picker, L.T("settings.llm.provider"));
            foreach (var (_, label) in options) picker.Items.Add(label);
            picker.SelectedIndex = Math.Max(0, Array.FindIndex(options, o => o.Item1 == provider));
            picker.SelectionChanged += (_, _) => { app.SetSetting("llm.provider", options[picker.SelectedIndex].Item1); Rebuild(); };

            var column = Ui.Column(8, Ui.Text(L.T("settings.llm.provider"), Theme.Body, FontWeights.SemiBold), picker);
            if (provider == "chatgpt")
            {
                var chatModel = Ui.Input(app.Settings.Str("llm.model"), L.T("settings.llm.model"));
                chatModel.LostFocus += (_, _) => app.SetSetting("llm.model", chatModel.Text);
                column.Children.Add(Ui.Text(L.T("settings.llm.model"), Theme.Body, FontWeights.SemiBold));
                column.Children.Add(chatModel);
                column.Children.Add(Ui.Text(L.T("settings.llm.chatgpt.help"), Theme.Caption, secondary: true));
                if (app.ChatGptWaiting && app.ChatGptCode.Length > 0)
                {
                    column.Children.Add(Ui.Text(L.T("settings.llm.chatgpt.code")));
                    var code = Ui.Text(app.ChatGptCode, Theme.Subtitle, FontWeights.SemiBold);
                    code.FontFamily = new System.Windows.Media.FontFamily("Consolas");
                    AutomationProperties.SetName(code, string.Join(" ", app.ChatGptCode.ToCharArray()));
                    column.Children.Add(code);
                    column.Children.Add(Ui.Row(
                        Ui.Button(L.T("settings.llm.chatgpt.copy"), () => Clipboard.SetText(app.ChatGptCode)),
                        Ui.Button(L.T("settings.llm.chatgpt.open"), () => app.OpenChatGptPage()),
                        Ui.Button(L.T("settings.llm.chatgpt.cancel"), () => app.CancelChatGptLogin())));
                    column.Children.Add(Ui.Text(L.T("settings.llm.chatgpt.waiting"), Theme.Caption, secondary: true));
                }
                else if (app.ChatGptSignedIn)
                {
                    var who = app.ChatGptEmail.Length > 0 ? L.T("settings.llm.chatgpt.signed_in_as", ("email", app.ChatGptEmail)) : L.T("settings.llm.chatgpt.signed_in");
                    column.Children.Add(Ui.Row(Ui.Text(who), Ui.Button(L.T("settings.llm.chatgpt.sign_out"), () => app.SignOutChatGpt())));
                }
                else
                {
                    column.Children.Add(Ui.Button(L.T("settings.llm.chatgpt.sign_in"), () => app.StartChatGptLogin(), prominent: true));
                }
                if (app.ChatGptError.Length > 0)
                {
                    var failed = Ui.Text(L.T("settings.llm.chatgpt.failed", ("error", app.ChatGptError)), Theme.Caption);
                    failed.Foreground = Theme.Warning;
                    column.Children.Add(failed);
                }
            }
            else if (provider != "none")
            {
                var model = Ui.Input(app.Settings.Str("llm.model"), L.T("settings.llm.model"));
                model.LostFocus += (_, _) => app.SetSetting("llm.model", model.Text);
                column.Children.Add(Ui.Text(L.T("settings.llm.model"), Theme.Body, FontWeights.SemiBold));
                column.Children.Add(model);
                if (provider == "openai-compatible")
                {
                    var url = Ui.Input(app.Settings.Str("llm.baseUrl"), L.T("settings.llm.base_url"));
                    url.LostFocus += (_, _) => app.SetSetting("llm.baseUrl", url.Text);
                    column.Children.Add(Ui.Text(L.T("settings.llm.base_url"), Theme.Body, FontWeights.SemiBold));
                    column.Children.Add(url);
                }
                var key = new PasswordBox { Width = 320, Padding = new Thickness(6, 4, 6, 4) };
                AutomationProperties.SetName(key, L.T("settings.llm.api_key"));
                var save = Ui.Button(L.T("approval.save"), () => { app.SaveApiKey(key.Password); key.Clear(); Rebuild(); });
                column.Children.Add(Ui.Text(L.T("settings.llm.api_key"), Theme.Body, FontWeights.SemiBold));
                column.Children.Add(Ui.Row(key, save));
                if (CredentialStore.Get("llm/apiKey") != null) column.Children.Add(Ui.Text(L.T("settings.llm.key_saved"), Theme.Caption, secondary: true));
            }
            if (!app.LlmReady)
            {
                var missing = Ui.Text(L.T("settings.llm.missing"));
                missing.Foreground = Theme.Warning;
                column.Children.Add(missing);
            }
            return column;
        }

        private UIElement Connectors()
        {
            var column = Ui.Column(4);
            foreach (var connector in app.Connectors)
            {
                var details = Ui.Column(2,
                    Ui.Text(connector.Name, Theme.Body, FontWeights.SemiBold),
                    Ui.Text(connector.Description, Theme.Caption, secondary: true));
                if (connector.Skeleton)
                {
                    var note = Ui.Text(L.T("settings.connectors.skeleton"), Theme.Caption);
                    note.Foreground = Theme.Warning;
                    details.Children.Add(note);
                    var clientId = Ui.Input("", "OAuth client ID");
                    clientId.Width = 300;
                    clientId.LostFocus += (_, _) => { if (clientId.Text.Length > 0) app.ConfigureConnector(connector.Id, new JsonObject { ["clientId"] = clientId.Text }); };
                    details.Children.Add(clientId);
                    if (connector.Enabled) details.Children.Add(Ui.LinkButton(L.T("settings.connectors.connect"), () => app.Connect(connector.Id)));
                }
                if (connector.Id is "files" or "obsidian")
                {
                    details.Children.Add(Ui.LinkButton(L.T("settings.stt.choose"), () =>
                    {
                        using var dialog = new System.Windows.Forms.FolderBrowserDialog();
                        if (dialog.ShowDialog() != System.Windows.Forms.DialogResult.OK) return;
                        JsonNode value = connector.Id == "files" ? new JsonArray(dialog.SelectedPath) : JsonValue.Create(dialog.SelectedPath)!;
                        app.ConfigureConnector(connector.Id, new JsonObject { [connector.Id == "files" ? "roots" : "vaultPath"] = value });
                    }));
                }
                var toggle = new CheckBox { IsChecked = connector.Enabled, VerticalAlignment = VerticalAlignment.Top, Margin = new Thickness(8, 2, 0, 0) };
                AutomationProperties.SetName(toggle, connector.Name);
                var id = connector.Id;
                toggle.Checked += (_, _) => { app.SetConnector(id, true); connector.Enabled = true; Rebuild(); };
                toggle.Unchecked += (_, _) => { app.SetConnector(id, false); connector.Enabled = false; Rebuild(); };
                var row = new DockPanel();
                var icon = Ui.Icon(Glyphs.For(connector.Icon), 18, Theme.Accent);
                icon.Margin = new Thickness(0, 2, 12, 0);
                icon.VerticalAlignment = VerticalAlignment.Top;
                DockPanel.SetDock(icon, Dock.Left);
                DockPanel.SetDock(toggle, Dock.Right);
                row.Children.Add(icon);
                row.Children.Add(toggle);
                row.Children.Add(details);
                column.Children.Add(Ui.Card(row));
            }
            column.Children.Add(Ui.Text(L.T("settings.connectors.mcp"), Theme.Subtitle, FontWeights.SemiBold));
            foreach (var server in app.McpServers.OfType<JsonObject>())
            {
                var line = server.Str("name") + "  ·  " + L.Count("settings.connectors.mcp_tools", server.Int("tools")) + "  ·  " + server.Str("state");
                column.Children.Add(Ui.Text(line));
            }
            var help = Ui.Text(L.T("settings.connectors.mcp_help"), Theme.Caption, secondary: true);
            help.FontFamily = new System.Windows.Media.FontFamily("Cascadia Mono, Consolas");
            column.Children.Add(help);
            column.Children.Add(Ui.LinkButton(L.T("panel.retry"), async () =>
            {
                try { await app.Core.Request("mcp.reload"); } catch (CoreException) { }
                app.RefreshConnectors(Rebuild);
            }));
            return column;
        }

        private UIElement Apps()
        {
            var column = Ui.Column(8, Ui.Text(L.T("settings.apps.intro"), Theme.Body, secondary: true));
            if (app.ComposioHasKey)
            {
                column.Children.Add(Ui.Row(
                    Ui.Text(L.T("settings.apps.key_saved")),
                    Ui.Button(L.T("settings.apps.remove_key"), () => app.RemoveComposioKey())));
            }
            else
            {
                var key = new PasswordBox { Width = 320, Padding = new Thickness(6, 4, 6, 4) };
                AutomationProperties.SetName(key, L.T("settings.apps.key"));
                column.Children.Add(Ui.Text(L.T("settings.apps.key"), Theme.Body, FontWeights.SemiBold));
                column.Children.Add(Ui.Row(key, Ui.Button(L.T("approval.save"), () => { app.SaveComposioKey(key.Password); key.Clear(); })));
                column.Children.Add(Ui.Text(L.T("settings.apps.key_help"), Theme.Caption, secondary: true));
            }
            if (app.ComposioError.Length > 0)
            {
                var failed = Ui.Text(L.T("settings.apps.failed", ("error", app.ComposioError)), Theme.Caption);
                failed.Foreground = Theme.Warning;
                column.Children.Add(failed);
            }
            if (!app.ComposioHasKey) return column;

            var search = Ui.Input("", L.T("settings.apps.search"));
            search.KeyDown += (_, e) => { if (e.Key == System.Windows.Input.Key.Enter) _ = app.RefreshComposioApps(search.Text); };
            column.Children.Add(search);
            if (app.ComposioApps.Count == 0 && !app.ComposioLoading) column.Children.Add(Ui.Text(L.T("settings.apps.empty"), Theme.Body, secondary: true));
            foreach (var item in app.ComposioApps.Take(60))
            {
                var slug = item.Str("slug");
                var connected = item.Bool("connected");
                var details = Ui.Column(2, Ui.Text(item.Str("name"), Theme.Body, FontWeights.SemiBold));
                if (item.Str("description").Length > 0) details.Children.Add(Ui.Text(item.Str("description"), Theme.Caption, secondary: true));
                if (connected)
                {
                    details.Children.Add(Ui.Toggle(L.T("settings.apps.read_only"), item.Bool("readOnly"), on => app.ConfigureComposioApp(slug, readOnly: on)));
                }
                if (app.ComposioConnecting == slug) details.Children.Add(Ui.Text(L.T("settings.apps.waiting"), Theme.Caption, secondary: true));
                var actions = connected
                    ? Ui.Row(
                        Ui.Toggle(L.T("settings.apps.use"), item.Bool("enabled", true), on => app.ConfigureComposioApp(slug, enabled: on)),
                        Ui.Button(L.T("settings.apps.disconnect"), () => app.DisconnectComposioApp(slug)))
                    : Ui.Row(Ui.Button(L.T("settings.apps.connect"), () => app.ConnectComposioApp(slug)));
                var row = new DockPanel();
                DockPanel.SetDock(actions, Dock.Right);
                row.Children.Add(actions);
                row.Children.Add(details);
                column.Children.Add(Ui.Card(row));
            }
            column.Children.Add(Ui.Text(L.T("settings.apps.privacy"), Theme.Caption, secondary: true));
            return column;
        }

        private UIElement Privacy()
        {
            var transcripts = Ui.Toggle(L.T("settings.save_transcripts"), Flag("history.saveTranscripts"), on =>
                app.SetSetting("history.saveTranscripts", on, reply =>
                {
                    if (!reply.Bool("offerDelete")) return;
                    var answer = MessageBox.Show(this, L.T("settings.delete_transcripts"), L.T("app.name"), MessageBoxButton.YesNo, MessageBoxImage.Question, MessageBoxResult.No);
                    if (answer == MessageBoxResult.Yes) app.Core.Send("history.clearTranscripts");
                }));
            var deleteAll = Ui.Button(L.T("settings.delete_all"), () =>
            {
                var answer = MessageBox.Show(this, L.T("settings.delete_all.confirm"), L.T("settings.delete_all.button"), MessageBoxButton.OKCancel, MessageBoxImage.Warning, MessageBoxResult.Cancel);
                if (answer == MessageBoxResult.OK) app.DeleteAllData();
            }, prominent: true, destructive: true);
            deleteAll.HorizontalAlignment = HorizontalAlignment.Left;
            return Ui.Column(8,
                transcripts,
                Ui.Text(L.T("settings.save_transcripts.help"), Theme.Caption, secondary: true),
                Toggle(L.T("settings.diagnostics"), "diagnostics.enabled"),
                Ui.Text(L.T("settings.diagnostics.help"), Theme.Caption, secondary: true),
                deleteAll);
        }
    }
}
