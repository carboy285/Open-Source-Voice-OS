using System;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Effects;
using System.Windows.Threading;

namespace Murmur
{
    /// <summary>A reminder card near the tray with Snooze (10 min) and Done.</summary>
    internal sealed class ReminderToast : Window
    {
        private readonly AppController app;
        private readonly int id;
        private readonly Border card;

        public ReminderToast(AppController app, int id, string text, bool missed)
        {
            this.app = app;
            this.id = id;
            WindowStyle = WindowStyle.None;
            AllowsTransparency = true;
            Background = Brushes.Transparent;
            Topmost = true;
            ShowInTaskbar = false;
            ShowActivated = false;
            SizeToContent = SizeToContent.Height;
            Width = 360;
            Backdrop.NoActivate(this);

            var body = Ui.Column(8,
                Ui.Text(L.T("notify.reminder"), Theme.Caption, FontWeights.SemiBold, secondary: true),
                Ui.Text(missed ? L.T("notify.reminder.missed", ("text", text)) : text, Theme.Subtitle, FontWeights.SemiBold));
            var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
            buttons.Children.Add(Ui.Button(L.T("notify.reminder.snooze"), () => Finish("reminders.snooze")));
            var done = Ui.Button(L.T("notify.reminder.done"), () => Finish("reminders.done"), prominent: true);
            done.IsDefault = true;
            buttons.Children.Add(done);
            body.Children.Add(buttons);
            card = new Border
            {
                Child = body,
                Background = Theme.Surface,
                BorderBrush = Theme.Stroke,
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(12),
                Padding = new Thickness(16),
                Margin = new Thickness(12),
                Effect = new DropShadowEffect { BlurRadius = 18, ShadowDepth = 3, Opacity = 0.22, Direction = 270 },
                Opacity = 0,
            };
            Content = card;
        }

        public void Present()
        {
            var area = Screens.WorkAreaAtPointer();
            Left = area.Right - Width - 8;
            Top = area.Bottom - 180;
            Show();
            Top = area.Bottom - ActualHeight - 8;
            Motion.Pop(card, true, new Point(1, 1));
            var timer = new DispatcherTimer { Interval = TimeSpan.FromMinutes(2) };
            timer.Tick += (_, _) => { timer.Stop(); Motion.Pop(card, false, new Point(1, 1), Close); };
            timer.Start();
        }

        private void Finish(string method)
        {
            app.Core.Send(method, new System.Text.Json.Nodes.JsonObject { ["id"] = id });
            Motion.Pop(card, false, new Point(1, 1), Close);
        }
    }
}
