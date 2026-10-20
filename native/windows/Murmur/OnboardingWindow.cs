using System;
using System.Linq;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using Microsoft.Win32;

namespace Murmur
{
    /// <summary>Guided introduction, access, model download and real dictation practice.</summary>
    internal sealed class OnboardingWindow : Window
    {
        private readonly AppController app;
        private readonly StackPanel body = Ui.Column(12);
        private readonly TextBlock progress = Ui.Text("", Theme.Caption, secondary: true);
        private TextBlock status = Ui.Text("", Theme.Caption, secondary: true);
        private readonly TextBlock result = Ui.Text("", Theme.Body);
        private readonly Button next, back;
        private readonly DispatcherTimer poll = new() { Interval = TimeSpan.FromSeconds(2) };
        private readonly DispatcherTimer practiceLimit = new() { Interval = TimeSpan.FromSeconds(20) };
        private Button? record, download;
        private int step;
        private bool ready, polling, downloading;
        private string? recommended;
        private bool closed;
        private readonly string[] steps = { "setup.welcome", "setup.permissions", "setup.model", "setup.practice" };

        public OnboardingWindow(AppController app)
        {
            this.app = app;
            Title = L.T("setup.title"); Width = 660; Height = 710; MinHeight = 580;
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            FontFamily = Theme.Font;
            Backdrop.Apply(this, transient: false, caption: true);
            next = Ui.Button(L.T("setup.begin"), Advance, prominent: true);
            back = Ui.Button(L.T("setup.back"), () => { if (step > 0) { step--; Render(); } });
            var footer = new DockPanel { Margin = new Thickness(24) };
            DockPanel.SetDock(next, Dock.Right); footer.Children.Add(next); footer.Children.Add(back);
            var header = Ui.Column(8, Ui.Text(L.T("setup.title"), Theme.Title, FontWeights.Bold), Ui.Text(L.T("setup.subtitle"), secondary: true), progress);
            header.Margin = new Thickness(28, 40, 28, 20);
            var scroll = new ScrollViewer { Content = body, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Padding = new Thickness(28, 8, 28, 16) };
            var layout = new DockPanel(); DockPanel.SetDock(header, Dock.Top); DockPanel.SetDock(footer, Dock.Bottom);
            layout.Children.Add(header); layout.Children.Add(footer); layout.Children.Add(scroll); Content = layout;
            poll.Tick += async (_, _) => await Check();
            practiceLimit.Tick += (_, _) => { practiceLimit.Stop(); if (app.SetupRecording) Practice(); };
            Loaded += async (_, _) => { Render(); await Check(); poll.Start(); };
            Closed += (_, _) => { closed = true; poll.Stop(); practiceLimit.Stop(); if (app.SetupRecording) app.Audio.Stop(); app.SetupRecording = false; };
        }

        private void Render()
        {
            body.Children.Clear(); record = null; download = null;
            status = Ui.Text("", Theme.Caption, secondary: true);
            progress.Text = string.Join("   →   ", steps.Select((s, i) => (i < step ? "✓ " : i == step ? "● " : "○ ") + L.T(s)));
            body.Children.Add(Ui.Text(L.T(steps[step]), Theme.Subtitle, FontWeights.SemiBold));
            back.Visibility = step == 0 ? Visibility.Hidden : Visibility.Visible;
            if (step == 0)
            {
                body.Children.Add(Ui.Text(L.T("setup.intro"), secondary: true));
                Feature("setup.dictate.title", "setup.dictate.body"); Feature("setup.edit.title", "setup.edit.body"); Feature("setup.ask.title", "setup.ask.body");
                body.Children.Add(Ui.Card(Ui.Text(L.T("setup.privacy"), secondary: true)));
            }
            else if (step == 1)
            {
                body.Children.Add(Ui.Text(L.T("setup.windows.permissions"), secondary: true));
                body.Children.Add(Ui.Card(Ui.Column(8, Ui.Text(L.T("onboarding.mic.title"), Theme.Body, FontWeights.SemiBold), Ui.Text(L.T("onboarding.mic.body"), secondary: true), Ui.Button(L.T("onboarding.open_settings"), Permissions.OpenMicrophoneSettings), status)));
            }
            else if (step == 2)
            {
                body.Children.Add(Ui.Text(L.T("setup.model.help"), secondary: true));
                download = Ui.Button(L.T("setup.download"), Download, prominent: true);
                body.Children.Add(Ui.Card(Ui.Column(12, status, download)));
                body.Children.Add(Ui.Text(L.T("setup.model.note"), secondary: true));
                body.Children.Add(Ui.Button(L.T("setup.open_settings"), app.ShowSettings));
            }
            else
            {
                body.Children.Add(Ui.Text(L.T("setup.practice.help"), secondary: true));
                record = Ui.Button(L.T("setup.record"), Practice, prominent: true); body.Children.Add(record); body.Children.Add(result);
                body.Children.Add(Ui.Text(L.T("setup.hotkey.help", ("key", app.HotkeyName))));
                var field = Ui.Input("", L.T("setup.test_field")); field.AcceptsReturn = true; field.MinHeight = 80;
                body.Children.Add(field);
                var inserted = Ui.Text(L.T("setup.insert_pending"), Theme.Caption, secondary: true);
                field.TextChanged += (_, _) => { if (app.State == ShellState.Inserting && field.Text.Length > 0) inserted.Text = L.T("setup.insert_pass"); };
                body.Children.Add(inserted);
                body.Children.Add(Ui.Text(L.T("setup.ai_optional"), Theme.Caption, secondary: true));
                body.Children.Add(Ui.Button(L.T("setup.open_settings"), app.ShowSettings));
            }
            UpdateButtons();
        }

        private void Feature(string title, string description) => body.Children.Add(Ui.Card(Ui.Column(6,
            Ui.Text(L.T(title), Theme.Subtitle, FontWeights.SemiBold), Ui.Text(L.T(description, ("key", app.HotkeyName)), secondary: true)), padding: 16));

        private void UpdateButtons()
        {
            next.Content = Ui.Text(L.T(step == 0 ? "setup.begin" : step == 3 ? "setup.finish" : "setup.next"), Theme.Body, FontWeights.SemiBold);
            next.IsEnabled = !app.SetupRecording && !app.SetupBusy && (step == 0 || step == 1 && Permissions.MicrophoneAllowed || step >= 2 && ready && Permissions.MicrophoneAllowed);
            back.IsEnabled = !app.SetupRecording && !app.SetupBusy;
            if (download != null) download.IsEnabled = !downloading && !ready && recommended != null;
        }

        private async System.Threading.Tasks.Task Check()
        {
            if (polling || closed) return;
            polling = true;
            try
            {
                var model = await app.Core.Request("models.list");
                var models = model?["models"] as JsonArray ?? new JsonArray();
                recommended = models.FirstOrDefault(m => m.Bool("recommended"))?.Str("id") ?? models.FirstOrDefault()?.Str("id");
                downloading = models.Any(m => m.Bool("downloading"));
                var state = await app.Core.Request("status"); ready = state.Bool("stt");
                if (step == 1) status.Text = L.T(Permissions.MicrophoneAllowed ? "onboarding.status.granted" : "onboarding.status.denied");
                if (step == 2) status.Text = L.T(ready ? "setup.model_ready" : downloading ? "setup.downloading" : "models.none");
            }
            catch (Exception) { status.Text = L.T("setup.failed"); }
            finally { polling = false; UpdateButtons(); }
        }

        private async void Download()
        {
            if (recommended == null) return;
            downloading = true; status.Text = L.T("setup.downloading"); UpdateButtons();
            try { await app.Core.Request("models.download", new JsonObject { ["id"] = recommended }); }
            catch (Exception error) { downloading = false; status.Text = error.Message; UpdateButtons(); }
        }

        private async void Practice()
        {
            if (app.SetupBusy) return;
            if (!app.SetupRecording)
            {
                if (app.Audio.IsRecording) return;
                try { app.Audio.Start(); app.SetupRecording = true; result.Text = ""; practiceLimit.Start(); }
                catch (Exception error) { result.Text = error.Message; }
            }
            else
            {
                practiceLimit.Stop(); var pcm = app.Audio.Stop(); app.SetupRecording = false; app.SetupBusy = true; UpdateButtons();
                try
                {
                    var reply = await app.Core.Request("setup.practice", new JsonObject { ["audio"] = Convert.ToBase64String(pcm), ["sampleRate"] = 16000 });
                    result.Text = reply.Str("text"); if (result.Text.Length == 0) result.Text = L.T("setup.no_speech");
                }
                catch (Exception error) { result.Text = error.Message; }
                finally { app.SetupBusy = false; }
            }
            if (record != null) record.Content = Ui.Text(L.T(app.SetupRecording ? "setup.stop" : "setup.record"));
            UpdateButtons();
        }

        private void Advance()
        {
            if (!next.IsEnabled) return;
            if (step < 3) { step++; Render(); _ = Check(); return; }
            Registry.SetValue(Permissions.AppKey, "Onboarded", 1); Close();
        }
    }
}
