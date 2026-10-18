using System;
using System.Linq;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Effects;
using System.Windows.Shapes;

namespace Murmur
{
    /// <summary>
    /// The listening capsule at the bottom of the screen, with the change report growing upward out of it.
    /// A layered window, so the pieces can scale and fade from the capsule; it never takes focus.
    /// </summary>
    internal sealed class IndicatorWindow : Window
    {
        private readonly AppController app;
        private readonly Border capsule;
        private readonly Border card;
        private readonly StackPanel cardBody = new();
        private readonly TextBlock label;
        private readonly TextBlock hint;
        private readonly TextBlock statusIcon;
        private readonly Rectangle[] bars;
        private bool capsuleShown, cardShown;

        public const double WindowWidth = 400, WindowHeight = 360;

        public IndicatorWindow(AppController app)
        {
            this.app = app;
            WindowStyle = WindowStyle.None;
            AllowsTransparency = true;
            Background = Brushes.Transparent;
            Topmost = true;
            ShowInTaskbar = false;
            ShowActivated = false;
            ResizeMode = ResizeMode.NoResize;
            Width = WindowWidth;
            Height = WindowHeight;
            Backdrop.NoActivate(this);

            bars = Enumerable.Range(0, 5).Select(_ => new Rectangle { Width = 3, Height = 4, RadiusX = 1.5, RadiusY = 1.5, Fill = Theme.Accent, Margin = new Thickness(1.5, 0, 1.5, 0), VerticalAlignment = VerticalAlignment.Center }).ToArray();
            var barRow = new StackPanel { Orientation = Orientation.Horizontal, Height = 18, Margin = new Thickness(0, 0, 8, 0) };
            foreach (var bar in bars) barRow.Children.Add(bar);
            statusIcon = Ui.Icon("", 14);
            label = Ui.Text("", Theme.Body, FontWeights.SemiBold, wrap: false);
            hint = Ui.Text(L.T("indicator.cancel_hint"), Theme.Caption, secondary: true, wrap: false);
            hint.Margin = new Thickness(8, 0, 0, 0);
            hint.VerticalAlignment = label.VerticalAlignment = VerticalAlignment.Center;
            var row = Ui.Row(barRow, statusIcon, label, hint);
            capsule = Surface(row, 22, new Thickness(16, 10, 16, 10));
            capsule.HorizontalAlignment = HorizontalAlignment.Center;
            capsule.Opacity = 0;
            AutomationProperties.SetLiveSetting(capsule, AutomationLiveSetting.Polite);

            card = Surface(cardBody, 14, new Thickness(16));
            card.Margin = new Thickness(0, 0, 0, 8);
            card.Opacity = 0;
            card.Visibility = Visibility.Collapsed;

            var stack = new StackPanel { VerticalAlignment = VerticalAlignment.Bottom, Margin = new Thickness(12) };
            stack.Children.Add(card);
            stack.Children.Add(capsule);
            Content = stack;
        }

        /// <summary>Translucent fill, or solid when Windows transparency effects are off.</summary>
        private static Border Surface(UIElement child, double radius, Thickness padding)
        {
            var fill = Theme.Surface is SolidColorBrush solid && !Theme.ReduceTransparency
                ? new SolidColorBrush(Color.FromArgb(0xEE, solid.Color.R, solid.Color.G, solid.Color.B))
                : Theme.Surface;
            return new Border
            {
                Child = child,
                Background = fill,
                BorderBrush = Theme.Stroke,
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(radius),
                Padding = padding,
                Effect = new DropShadowEffect { BlurRadius = 18, ShadowDepth = 3, Opacity = 0.22, Direction = 270 },
            };
        }

        public void Place()
        {
            var area = Screens.WorkAreaAtPointer(this);
            Left = area.Left + (area.Width - WindowWidth) / 2;
            Top = area.Bottom - WindowHeight - 8;
        }

        /// <summary>Center of the capsule on screen, where popovers and the approval window come from.</summary>
        public Point Origin => new(Left + WindowWidth / 2, Top + WindowHeight - 32);

        public void ShowCapsule()
        {
            if (!IsVisible)
            {
                Place();
                Show();
            }
            Refresh();
            if (capsuleShown) return;
            capsuleShown = true;
            Motion.Pop(capsule, true, new Point(0.5, 0.5));
        }

        public void HideAll()
        {
            capsuleShown = false;
            HideCard();
            Motion.Pop(capsule, false, new Point(0.5, 0.5), () =>
            {
                if (!capsuleShown && !cardShown) Hide();
            });
        }

        public void SetLevel(float level)
        {
            double[] weights = { 0.5, 0.8, 1, 0.8, 0.5 };
            for (var i = 0; i < bars.Length; i++) bars[i].Height = 4 + 14 * Math.Min(1, level * weights[i] * 1.4);
        }

        public void Refresh()
        {
            var state = app.State;
            var listening = state == ShellState.Listening;
            foreach (var bar in bars) bar.Visibility = listening ? Visibility.Visible : Visibility.Collapsed;
            hint.Visibility = listening ? Visibility.Visible : Visibility.Collapsed;
            statusIcon.Visibility = listening ? Visibility.Collapsed : Visibility.Visible;
            statusIcon.Text = state switch { ShellState.Error => "", ShellState.Done => "", _ => "" };
            statusIcon.Foreground = state switch { ShellState.Error => Theme.Warning, ShellState.Done => Theme.Success, _ => Theme.Secondary };
            statusIcon.Margin = new Thickness(0, 0, 8, 0);
            label.Text = state switch
            {
                ShellState.Listening => app.Action == HotkeyAction.Agent ? L.T("indicator.agent") : L.T("indicator.listening"),
                ShellState.Error => L.T("menu.state.error"),
                ShellState.Done => L.T("menu.state.done"),
                _ => L.T("indicator.working"),
            };
            hint.Text = L.T("indicator.cancel_hint");
            AutomationProperties.SetName(capsule, label.Text);
        }

        /// <summary>The change report or a short message, growing out of the capsule.</summary>
        public void ShowCard()
        {
            cardBody.Children.Clear();
            var header = new DockPanel { LastChildFill = true, Margin = new Thickness(0, 0, 0, 8) };
            var close = Ui.LinkButton("✕", () => app.DismissReport());
            AutomationProperties.SetName(close, L.T("approval.cancel"));
            DockPanel.SetDock(close, Dock.Right);
            header.Children.Add(close);
            header.Children.Add(Ui.Heading(app.Report.Count == 0 ? L.T("app.name") : L.T("report.title")));
            cardBody.Children.Add(header);
            if (!string.IsNullOrEmpty(app.ReportMessage)) cardBody.Children.Add(Ui.Text(app.ReportMessage));
            foreach (var item in app.Report)
            {
                var line = Ui.Row(Ui.Icon(IconFor(item.Category), 14, Theme.Accent), Ui.Text(item.Label));
                ((FrameworkElement)line.Children[0]).Margin = new Thickness(0, 0, 8, 0);
                line.Margin = new Thickness(0, 2, 0, 2);
                cardBody.Children.Add(line);
            }
            if (app.State == ShellState.Error)
            {
                var retry = Ui.Button(L.T("error.retry"), app.RetryDictation, prominent: true);
                retry.HorizontalAlignment = HorizontalAlignment.Left;
                retry.Margin = new Thickness(0, 8, 0, 0);
                cardBody.Children.Add(retry);
            }
            if (!IsVisible)
            {
                Place();
                Show();
            }
            card.Visibility = Visibility.Visible;
            if (cardShown) return;
            cardShown = true;
            Motion.Pop(card, true, new Point(0.5, 1));
        }

        public void HideCard()
        {
            if (!cardShown) return;
            cardShown = false;
            Motion.Pop(card, false, new Point(0.5, 1), () =>
            {
                if (!cardShown) card.Visibility = Visibility.Collapsed;
            });
        }

        private static string IconFor(string category) => category switch
        {
            "filler_removed" => "",
            "dictionary_applied" or "dictionary_added" => "",
            "spelling_fixed" or "grammar_fixed" => "",
            "list_formatted" => "",
            "polish_rejected" => "",
            _ => "",
        };
    }
}
