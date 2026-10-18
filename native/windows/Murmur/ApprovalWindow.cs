using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;

namespace Murmur
{
    /// <summary>Dims the screen behind an approval preview. The preview is modal for its task.</summary>
    internal sealed class DimWindow : Window
    {
        public DimWindow()
        {
            WindowStyle = WindowStyle.None;
            AllowsTransparency = true;
            Background = new SolidColorBrush(Color.FromArgb(0x38, 0, 0, 0));
            Topmost = true;
            ShowInTaskbar = false;
            ShowActivated = false;
            ResizeMode = ResizeMode.NoResize;
            Opacity = 0;
        }

        public void Cover()
        {
            var bounds = Screens.BoundsAtPointer(this);
            Left = bounds.Left;
            Top = bounds.Top;
            Width = bounds.Width;
            Height = bounds.Height;
            if (!IsVisible) Show();
            Motion.To(this, OpacityProperty, 1, 250);
        }

        public void Uncover() => Motion.To(this, OpacityProperty, 0, 250, () => { if (Opacity == 0) Hide(); });
    }

    /// <summary>
    /// Edit / Cancel / Send. Send is the default button; Esc and closing the window mean Cancel.
    /// A destructive action shows a red button and needs a second click (the core asks again).
    /// </summary>
    internal sealed class ApprovalWindow : Window
    {
        private readonly AppController app;
        private readonly StackPanel body = new() { Margin = new Thickness(24, 40, 24, 20) };
        private readonly Dictionary<string, TextBox> editors = new();
        private Preview? preview;
        private bool editing;
        private bool closingForReal;
        private readonly DimWindow dim;

        public ApprovalWindow(AppController app, DimWindow dim)
        {
            this.app = app;
            this.dim = dim;
            Title = L.T("approval.title");
            Width = 500;
            SizeToContent = SizeToContent.Height;
            ResizeMode = ResizeMode.NoResize;
            Topmost = true;
            ShowInTaskbar = true;
            FontFamily = Theme.Font;
            Backdrop.Apply(this, transient: false, caption: true);
            Content = new ScrollViewer { Content = body, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, MaxHeight = 640 };
            // Esc reaches the Cancel button (IsCancel); closing the window also cancels.
            Closing += OnClosing;
        }

        public string? CallId => preview?.CallId;

        /// <summary>Shows a preview. A refreshed preview for the same call (after Edit, or the confirm step) replaces it in place.</summary>
        public void Present(Preview next, Point origin)
        {
            var isNew = preview?.CallId != next.CallId;
            preview = next;
            editing = false;
            Build();
            if (!IsVisible)
            {
                // An owned window always stays above the dimmed backdrop. Owner can only be set once the owner was shown.
                if (Owner == null && dim.IsVisible) Owner = dim;
                BeginAnimation(LeftProperty, null);
                BeginAnimation(TopProperty, null);
                var area = Screens.WorkAreaAtPointer(this);
                var targetLeft = area.Left + (area.Width - Width) / 2;
                var targetTop = area.Top + area.Height * 0.22;
                // Starts at the indicator and glides to the center.
                Left = Theme.ReduceMotion ? targetLeft : origin.X - Width / 2;
                Top = Theme.ReduceMotion ? targetTop : Math.Max(area.Top, origin.Y - 200);
                body.Opacity = 0;
                Show();
                Motion.To(this, LeftProperty, targetLeft);
                Motion.To(this, TopProperty, targetTop);
                Motion.Pop(body, true, new Point(0.5, 1));
            }
            else if (isNew)
            {
                body.Opacity = 0;
                Motion.Pop(body, true, new Point(0.5, 0.5));
            }
            Activate();
        }

        public void Dismiss()
        {
            preview = null;
            closingForReal = true;
            Hide();
            closingForReal = false;
        }

        private void OnClosing(object? sender, CancelEventArgs e)
        {
            if (closingForReal) return;
            e.Cancel = true;
            Respond("cancel");
        }

        private void Respond(string decision, JsonObject? input = null)
        {
            if (preview == null) return;
            app.RespondApproval(preview, decision, input);
        }

        private void Build()
        {
            if (preview == null) return;
            body.Children.Clear();
            editors.Clear();

            var header = Ui.Row(
                Ui.Icon(Glyphs.For(preview.Icon), 18, preview.Destructive ? Theme.Destructive : Theme.Accent),
                Ui.Text(preview.DisplayName, Theme.Body, FontWeights.SemiBold, secondary: true, wrap: false));
            ((FrameworkElement)header.Children[0]).Margin = new Thickness(0, 0, 8, 0);
            if (preview.Edited)
            {
                var badge = new Border { Child = Ui.Text(L.T("approval.edited"), Theme.Caption, FontWeights.SemiBold), Background = Theme.Subtle, CornerRadius = new CornerRadius(8), Padding = new Thickness(8, 1, 8, 1), Margin = new Thickness(8, 0, 0, 0) };
                header.Children.Add(badge);
            }
            header.Margin = new Thickness(0, 0, 0, 12);
            body.Children.Add(header);

            var summary = Ui.Text(preview.Summary, Theme.Title, FontWeights.SemiBold);
            summary.Margin = new Thickness(0, 0, 0, 16);
            AutomationProperties.SetHeadingLevel(summary, AutomationHeadingLevel.Level1);
            body.Children.Add(summary);

            if (preview.Errors.Count > 0)
            {
                var errors = Ui.Column(4, Ui.Text(L.T("approval.errors"), Theme.Body, FontWeights.SemiBold));
                foreach (var error in preview.Errors) errors.Children.Add(Ui.Text(error));
                foreach (var child in errors.Children.OfType<TextBlock>()) child.Foreground = Theme.Destructive;
                errors.Margin = new Thickness(0, 0, 0, 12);
                body.Children.Add(errors);
            }

            foreach (var field in preview.Fields)
            {
                var label = Ui.Text(field.Label, Theme.Caption, FontWeights.SemiBold, secondary: true);
                label.Margin = new Thickness(0, 0, 0, 4);
                body.Children.Add(label);
                if (editing)
                {
                    var box = Ui.Input(field.Text, field.Label, field.Type == "longtext");
                    box.Margin = new Thickness(0, 0, 0, field.Type == "recipients" ? 2 : 12);
                    editors[field.Key] = box;
                    body.Children.Add(box);
                    if (field.Type == "recipients")
                    {
                        var hint = Ui.Text(L.T("approval.recipients_hint"), Theme.Caption, secondary: true);
                        hint.Margin = new Thickness(0, 0, 0, 12);
                        body.Children.Add(hint);
                    }
                }
                else
                {
                    var value = Ui.Text(string.IsNullOrEmpty(field.Text) ? "—" : field.Text);
                    value.Margin = new Thickness(0, 0, 0, 12);
                    value.MaxHeight = field.Type == "longtext" ? 160 : 44;
                    AutomationProperties.SetName(value, field.Label + ": " + field.Text);
                    body.Children.Add(value);
                }
            }

            var details = new Expander
            {
                Header = Ui.Text(L.T("approval.details"), Theme.Body),
                Content = new TextBox
                {
                    Text = preview.Raw.ToJsonString(new JsonSerializerOptions { WriteIndented = true }),
                    IsReadOnly = true,
                    FontFamily = new FontFamily("Cascadia Mono, Consolas"),
                    FontSize = Theme.Caption,
                    TextWrapping = TextWrapping.Wrap,
                    MaxHeight = 160,
                    VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                    BorderThickness = new Thickness(0),
                    Background = Brushes.Transparent,
                    Foreground = Theme.Text,
                },
                Margin = new Thickness(0, 0, 0, 16),
            };
            AutomationProperties.SetName(details, L.T("approval.details"));
            body.Children.Add(details);

            var buttons = new DockPanel { LastChildFill = false };
            if (editing)
            {
                var save = Ui.Button(L.T("approval.save"), Save, prominent: true);
                save.IsDefault = true;
                var cancel = Ui.Button(L.T("approval.cancel"), () => Respond("cancel"));
                cancel.IsCancel = true;
                DockPanel.SetDock(save, Dock.Left);
                DockPanel.SetDock(cancel, Dock.Right);
                buttons.Children.Add(save);
                buttons.Children.Add(cancel);
            }
            else
            {
                var edit = Ui.Button(L.T("approval.edit"), () => { editing = true; Build(); editors.Values.FirstOrDefault()?.Focus(); });
                edit.IsEnabled = preview.Fields.Count > 0;
                var verb = L.T("approval.verb." + preview.Verb);
                var send = Ui.Button(preview.Confirming ? L.T("approval.confirm") : verb, () => Respond("approve"), prominent: true, destructive: preview.Destructive);
                send.IsDefault = true;
                var cancel = Ui.Button(L.T("approval.cancel"), () => Respond("cancel"));
                cancel.IsCancel = true;
                DockPanel.SetDock(edit, Dock.Left);
                DockPanel.SetDock(send, Dock.Right);
                DockPanel.SetDock(cancel, Dock.Right);
                buttons.Children.Add(edit);
                buttons.Children.Add(send);
                buttons.Children.Add(cancel);
                send.Loaded += (_, _) => send.Focus();
            }
            buttons.Margin = new Thickness(0, 0, 0, 8);
            body.Children.Add(buttons);

            var minutes = Math.Max(1, (int)(preview.ExpiresAt - DateTime.Now).TotalMinutes);
            body.Children.Add(Ui.Text(L.T("approval.expires", ("minutes", minutes.ToString())), Theme.Caption, secondary: true));
        }

        /// <summary>Sends edited values; the core validates them and shows the preview again.</summary>
        private void Save()
        {
            if (preview == null) return;
            var input = (JsonObject)preview.Raw.DeepClone();
            foreach (var field in preview.Fields)
            {
                if (!editors.TryGetValue(field.Key, out var box)) continue;
                if (field.IsList)
                {
                    var list = new JsonArray();
                    foreach (var part in box.Text.Split(',').Select(p => p.Trim()).Where(p => p.Length > 0)) list.Add(part);
                    input[field.Key] = list;
                }
                else
                {
                    input[field.Key] = box.Text;
                }
            }
            editing = false;
            Respond("edit", input);
        }
    }
}
