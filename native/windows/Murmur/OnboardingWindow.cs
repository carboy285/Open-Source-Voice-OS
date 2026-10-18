using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;
using Microsoft.Win32;

namespace Murmur
{
    /// <summary>First run: the microphone (required) with a live status, plus what Windows does not need.</summary>
    internal sealed class OnboardingWindow : Window
    {
        private readonly AppController app;
        private readonly TextBlock micStatus;
        private readonly Button done;
        private readonly DispatcherTimer poll = new() { Interval = TimeSpan.FromSeconds(1) };

        public OnboardingWindow(AppController app)
        {
            this.app = app;
            Title = L.T("onboarding.title");
            Width = 520;
            SizeToContent = SizeToContent.Height;
            ResizeMode = ResizeMode.NoResize;
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            FontFamily = Theme.Font;
            Backdrop.Apply(this, transient: false, caption: true);

            micStatus = Ui.Text("", Theme.Caption, FontWeights.SemiBold, wrap: false);
            done = Ui.Button(L.T("onboarding.done"), Finish, prominent: true);
            done.IsDefault = true;

            var mic = Ui.Column(4,
                Ui.Row(Ui.Icon("", 20, Theme.Accent), Ui.Text("  " + L.T("onboarding.mic.title"), Theme.Subtitle, FontWeights.SemiBold), Ui.Text("   "), micStatus),
                Ui.Text(L.T("onboarding.mic.body"), secondary: true),
                Ui.Row(Ui.Button(L.T("onboarding.open_settings"), Permissions.OpenMicrophoneSettings)));
            var note = Ui.Column(4,
                Ui.Row(Ui.Icon("", 20, Theme.Accent), Ui.Text("  " + L.T("onboarding.ax.title"), Theme.Subtitle, FontWeights.SemiBold)),
                Ui.Text(L.T("onboarding.ax.body"), secondary: true),
                Ui.Text(L.T("onboarding.elevated_note"), secondary: true));

            var footer = new DockPanel { Margin = new Thickness(0, 8, 0, 0) };
            DockPanel.SetDock(done, Dock.Right);
            footer.Children.Add(done);
            footer.Children.Add(Ui.Text(L.T("menu.hotkey.dictate", ("key", app.HotkeyName)), secondary: true));

            Content = Ui.Column(16,
                Ui.Text(L.T("onboarding.title"), Theme.Title, FontWeights.SemiBold),
                Ui.Text(L.T("onboarding.subtitle"), secondary: true),
                Ui.Card(mic, padding: 16),
                Ui.Card(note, padding: 16),
                footer);
            ((FrameworkElement)Content).Margin = new Thickness(24, 40, 24, 24);

            poll.Tick += (_, _) => UpdateStatus();
            Loaded += (_, _) => { UpdateStatus(); poll.Start(); };
            Closed += (_, _) => poll.Stop();
        }

        private void UpdateStatus()
        {
            var allowed = Permissions.MicrophoneAllowed;
            micStatus.Text = allowed ? L.T("onboarding.status.granted") : L.T("onboarding.status.denied");
            micStatus.Foreground = allowed ? Theme.Success : Theme.Destructive;
            done.IsEnabled = allowed;
        }

        private void Finish()
        {
            Registry.SetValue(Permissions.AppKey, "Onboarded", 1);
            Close();
        }
    }
}
