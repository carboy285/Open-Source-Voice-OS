using System;
using System.Drawing;
using System.Windows;
using System.Windows.Forms;

namespace Murmur
{
    /// <summary>The tray icon and its menu: current state, hotkeys, recent history, Tasks, Settings and Quit.</summary>
    internal sealed class Tray : IDisposable
    {
        private readonly AppController app;
        private readonly NotifyIcon icon;
        private readonly ContextMenuStrip menu = new();

        public Tray(AppController app)
        {
            this.app = app;
            icon = new NotifyIcon { Icon = LoadIcon(), Visible = true, Text = "Murmur", ContextMenuStrip = menu };
            menu.Opening += (_, _) => Build();
            icon.MouseClick += (_, e) =>
            {
                if (e.Button == MouseButtons.Left) app.ShowPanel();
            };
            Build();
        }

        /// <summary>The app icon embedded in Murmur.exe (ApplicationIcon).</summary>
        private static Icon LoadIcon()
        {
            try
            {
                return Environment.ProcessPath is { } path ? Icon.ExtractAssociatedIcon(path) ?? SystemIcons.Application : SystemIcons.Application;
            }
            catch (ArgumentException)
            {
                return SystemIcons.Application;
            }
        }

        /// <summary>Approximate tray position, for previews that open from the tray.</summary>
        public System.Windows.Point Origin
        {
            get
            {
                var area = Screens.WorkAreaAtPointer();
                return new System.Windows.Point(area.Right - 80, area.Bottom);
            }
        }

        public void Refresh()
        {
            var text = L.T("app.name") + ": " + L.T("menu.state." + app.State.ToString().ToLowerInvariant());
            icon.Text = text.Length > 63 ? text[..63] : text;
        }

        public void Balloon(string title, string body)
        {
            icon.BalloonTipTitle = title;
            icon.BalloonTipText = string.IsNullOrEmpty(body) ? " " : body;
            icon.ShowBalloonTip(5000);
        }

        private void Build()
        {
            menu.Items.Clear();
            menu.Font = new Font("Segoe UI", 9f);
            menu.Items.Add(new ToolStripMenuItem(L.T("menu.state." + app.State.ToString().ToLowerInvariant())) { Enabled = false });
            if (app.Notice != null) menu.Items.Add(new ToolStripMenuItem(app.Notice) { Enabled = false });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem(L.T("menu.hotkey.dictate", ("key", app.HotkeyName))) { Enabled = false });
            menu.Items.Add(new ToolStripMenuItem(L.T("menu.hotkey.agent", ("key", app.HotkeyName + " + Shift"))) { Enabled = false });
            menu.Items.Add(new ToolStripMenuItem(L.T("menu.hotkey.edit", ("key", app.HotkeyName + " + Ctrl"))) { Enabled = false });
            menu.Items.Add(new ToolStripSeparator());
            var recent = new ToolStripMenuItem(L.T("menu.recent"));
            if (app.Recent.Count == 0) recent.DropDownItems.Add(new ToolStripMenuItem(L.T("menu.recent.empty")) { Enabled = false });
            foreach (var item in app.Recent) recent.DropDownItems.Add(new ToolStripMenuItem(item) { Enabled = false });
            menu.Items.Add(recent);
            menu.Items.Add(new ToolStripMenuItem(L.T("menu.tasks"), null, (_, _) => app.ShowPanel()));
            menu.Items.Add(new ToolStripMenuItem(L.T("menu.settings"), null, (_, _) => app.ShowSettings()));
            if (!Permissions.MicrophoneAllowed) menu.Items.Add(new ToolStripMenuItem(L.T("onboarding.title"), null, (_, _) => app.ShowOnboarding()));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem(L.T("menu.quit"), null, (_, _) => app.Quit()));
        }

        public void Dispose()
        {
            icon.Visible = false;
            icon.Dispose();
            menu.Dispose();
        }
    }
}
