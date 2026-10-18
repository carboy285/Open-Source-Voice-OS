using System;
using System.Linq;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Media;

namespace Murmur
{
    /// <summary>
    /// Non-blocking panel docked to the right edge: running tasks, pending approvals and history.
    /// It slides in from that edge and leaves the same way; reopening mid-slide continues from where it is.
    /// </summary>
    internal sealed class SidePanelWindow : Window
    {
        private readonly AppController app;
        private readonly StackPanel content = new() { Margin = new Thickness(16, 8, 16, 16) };
        private readonly TextBox search;
        private bool open;
        private Rect area;
        public const double PanelWidth = 380;

        public SidePanelWindow(AppController app)
        {
            this.app = app;
            Title = L.T("panel.title");
            WindowStyle = WindowStyle.None;
            ResizeMode = ResizeMode.NoResize;
            ShowInTaskbar = false;
            ShowActivated = false;
            Topmost = true;
            Width = PanelWidth;
            FontFamily = Theme.Font;
            Backdrop.Apply(this, transient: false);

            var header = new DockPanel { Margin = new Thickness(16, 16, 16, 8) };
            var close = Ui.LinkButton("✕", () => app.HidePanel());
            AutomationProperties.SetName(close, L.T("approval.cancel"));
            DockPanel.SetDock(close, Dock.Right);
            header.Children.Add(close);
            header.Children.Add(Ui.Text(L.T("panel.title"), Theme.Title, FontWeights.SemiBold));

            search = Ui.Input("", L.T("panel.search"));
            search.Margin = new Thickness(16, 0, 16, 8);
            search.TextChanged += (_, _) => app.RefreshHistory(search.Text);

            var root = new DockPanel();
            DockPanel.SetDock(header, Dock.Top);
            DockPanel.SetDock(search, Dock.Top);
            root.Children.Add(header);
            root.Children.Add(search);
            root.Children.Add(new ScrollViewer { Content = content, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });
            Content = root;
            KeyDown += (_, e) => { if (e.Key == System.Windows.Input.Key.Escape) app.HidePanel(); };
        }

        public bool IsOpen => open;

        public void Open()
        {
            open = true;
            if (!IsVisible)
            {
                area = Screens.WorkAreaAtPointer(this);
                BeginAnimation(LeftProperty, null);
                Top = area.Top + 8;
                Height = area.Height - 16;
                Left = area.Right;
                Show();
            }
            Refresh();
            Motion.To(this, LeftProperty, area.Right - PanelWidth - 8, 320);
            if (Theme.ReduceMotion) Motion.To((Panel)Content, OpacityProperty, 1, 180);
        }

        public void SlideOut()
        {
            open = false;
            if (Theme.ReduceMotion) Motion.To((Panel)Content, OpacityProperty, 0, 180, HideIfClosed);
            else Motion.To(this, LeftProperty, area.Right + 8, 320, HideIfClosed);
        }

        private void HideIfClosed()
        {
            if (!open) Hide();
        }

        public void Refresh()
        {
            content.Children.Clear();
            foreach (var preview in app.Approvals)
            {
                var review = Ui.Button(L.T("panel.approve_pending"), app.ShowApproval, prominent: true);
                var row = new DockPanel();
                DockPanel.SetDock(review, Dock.Right);
                row.Children.Add(review);
                row.Children.Add(Ui.Text(preview.Summary));
                content.Children.Add(Ui.Card(row, Theme.Solid(0x22FFB900)));
            }

            var active = app.Tasks.Values.Where(t => t.IsActive).OrderByDescending(t => t.StartedAt).ToList();
            if (active.Count > 0) content.Children.Add(Section(L.T("panel.current")));
            foreach (var task in active)
            {
                var column = Ui.Column(4);
                var top = new DockPanel();
                var stop = Ui.Button(L.T("panel.cancel_task"), () => app.CancelTask(task.Id));
                DockPanel.SetDock(stop, Dock.Right);
                top.Children.Add(stop);
                top.Children.Add(Ui.Text(L.T("panel.status." + task.Status), Theme.Body, FontWeights.SemiBold));
                column.Children.Add(top);
                if (task.CurrentStep != null) column.Children.Add(Ui.Text(task.CurrentStep, Theme.Caption, secondary: true));
                foreach (var step in task.Steps)
                {
                    column.Children.Add(Ui.Text(step.InputSummary));
                    column.Children.Add(Ui.Text(L.T("panel.approval." + step.Approval), Theme.Caption, secondary: true));
                }
                content.Children.Add(Ui.Card(column));
            }

            content.Children.Add(Section(L.T("panel.history")));
            var finished = app.History.Where(t => !t.IsActive).ToList();
            if (finished.Count == 0)
            {
                content.Children.Add(Ui.Text(L.T("panel.empty", ("key", app.HotkeyName + " + Shift")), secondary: true));
            }
            foreach (var task in finished)
            {
                var column = Ui.Column(4);
                var top = new DockPanel();
                var status = Ui.Text(L.T("panel.status." + task.Status), Theme.Caption, secondary: true, wrap: false);
                DockPanel.SetDock(status, Dock.Right);
                top.Children.Add(status);
                top.Children.Add(Ui.Text(task.Transcript ?? L.T("panel.transcript_hidden"), Theme.Body, FontWeights.SemiBold));
                column.Children.Add(top);
                if (task.Reply.Length > 0) column.Children.Add(Ui.Text(task.Reply, secondary: true));
                var again = Ui.LinkButton(task.Status == "failed" ? L.T("panel.retry") : L.T("panel.run_again"), () => app.RunAgain(task.Id));
                again.IsEnabled = task.Transcript != null;
                column.Children.Add(Ui.Row(Ui.Text(task.StartedAt.ToString("g"), Theme.Caption, secondary: true, wrap: false)));
                column.Children.Add(again);
                content.Children.Add(Ui.Card(column));
            }
        }

        private static TextBlock Section(string title)
        {
            var text = Ui.Text(title, Theme.Subtitle, FontWeights.SemiBold);
            text.Margin = new Thickness(0, 8, 0, 8);
            AutomationProperties.SetHeadingLevel(text, AutomationHeadingLevel.Level2);
            return text;
        }
    }
}
