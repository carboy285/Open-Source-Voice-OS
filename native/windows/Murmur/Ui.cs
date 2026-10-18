using System;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;

namespace Murmur
{
    /// <summary>Small builders so every surface shares type, spacing (4/8 grid) and button behavior.</summary>
    internal static class Ui
    {
        public static TextBlock Text(string text, double? size = null, FontWeight? weight = null, bool secondary = false, bool wrap = true) => new()
        {
            Text = text,
            FontFamily = Theme.Font,
            FontSize = size ?? Theme.Body,
            FontWeight = weight ?? FontWeights.Normal,
            Foreground = secondary ? Theme.Secondary : Theme.Text,
            TextWrapping = wrap ? TextWrapping.Wrap : TextWrapping.NoWrap,
            TextTrimming = wrap ? TextTrimming.None : TextTrimming.CharacterEllipsis,
        };

        public static TextBlock Heading(string text) => Text(text, Theme.Subtitle, FontWeights.SemiBold);

        public static TextBlock Icon(string glyph, double size = 16, Brush? brush = null) => new()
        {
            Text = glyph,
            FontFamily = Theme.Icons,
            FontSize = size,
            Foreground = brush ?? Theme.Text,
            VerticalAlignment = VerticalAlignment.Center,
        };

        /// <summary>A button whose pressed state shows on mouse-down. Prominent buttons use the accent (or red when destructive).</summary>
        public static Button Button(string label, Action onClick, bool prominent = false, bool destructive = false)
        {
            var background = prominent ? (destructive ? Theme.Destructive : Theme.Accent) : Theme.Subtle;
            var foreground = prominent ? Brushes.White : Theme.Text;
            var border = new FrameworkElementFactory(typeof(Border));
            border.Name = "Chrome";
            border.SetValue(Border.CornerRadiusProperty, new CornerRadius(6));
            border.SetValue(Border.BackgroundProperty, background);
            border.SetValue(Border.BorderBrushProperty, Theme.Stroke);
            border.SetValue(Border.BorderThicknessProperty, new Thickness(prominent ? 0 : 1));
            border.SetValue(Border.PaddingProperty, new Thickness(16, 6, 16, 6));
            var content = new FrameworkElementFactory(typeof(ContentPresenter));
            content.SetValue(ContentPresenter.HorizontalAlignmentProperty, HorizontalAlignment.Center);
            content.SetValue(ContentPresenter.VerticalAlignmentProperty, VerticalAlignment.Center);
            border.AppendChild(content);
            var template = new ControlTemplate(typeof(Button)) { VisualTree = border };
            var pressed = new Trigger { Property = ButtonBase_IsPressed, Value = true };
            pressed.Setters.Add(new Setter(UIElement.OpacityProperty, 0.78, "Chrome"));
            var hover = new Trigger { Property = UIElement.IsMouseOverProperty, Value = true };
            hover.Setters.Add(new Setter(UIElement.OpacityProperty, 0.92, "Chrome"));
            var disabled = new Trigger { Property = UIElement.IsEnabledProperty, Value = false };
            disabled.Setters.Add(new Setter(UIElement.OpacityProperty, 0.45, "Chrome"));
            template.Triggers.Add(hover);
            template.Triggers.Add(pressed);
            template.Triggers.Add(disabled);

            var button = new Button
            {
                Content = new TextBlock { Text = label, FontFamily = Theme.Font, FontSize = Theme.Body, FontWeight = prominent ? FontWeights.SemiBold : FontWeights.Normal, Foreground = foreground },
                Template = template,
                Cursor = Cursors.Hand,
                Margin = new Thickness(4, 0, 4, 0),
                MinWidth = 72,
            };
            AutomationProperties.SetName(button, label);
            button.Click += (_, _) => onClick();
            return button;
        }

        private static readonly DependencyProperty ButtonBase_IsPressed = System.Windows.Controls.Primitives.ButtonBase.IsPressedProperty;

        public static Button LinkButton(string label, Action onClick)
        {
            var text = new TextBlock { Text = label, FontFamily = Theme.Font, FontSize = Theme.Body, Foreground = Theme.Accent };
            var button = new Button { Content = text, Background = Brushes.Transparent, BorderThickness = new Thickness(0), Cursor = Cursors.Hand, Padding = new Thickness(0), HorizontalAlignment = HorizontalAlignment.Left };
            AutomationProperties.SetName(button, label);
            button.Click += (_, _) => onClick();
            return button;
        }

        public static CheckBox Toggle(string label, bool value, Action<bool> changed)
        {
            var box = new CheckBox
            {
                Content = Text(label),
                IsChecked = value,
                Margin = new Thickness(0, 4, 0, 4),
                VerticalContentAlignment = VerticalAlignment.Center,
            };
            AutomationProperties.SetName(box, label);
            box.Checked += (_, _) => changed(true);
            box.Unchecked += (_, _) => changed(false);
            return box;
        }

        public static TextBox Input(string value, string label, bool multiline = false)
        {
            var box = new TextBox
            {
                Text = value,
                FontFamily = Theme.Font,
                FontSize = Theme.Body,
                Padding = new Thickness(6, 4, 6, 4),
                AcceptsReturn = multiline,
                TextWrapping = multiline ? TextWrapping.Wrap : TextWrapping.NoWrap,
                MinHeight = multiline ? 88 : 0,
                MaxHeight = multiline ? 180 : double.PositiveInfinity,
                VerticalScrollBarVisibility = multiline ? ScrollBarVisibility.Auto : ScrollBarVisibility.Disabled,
            };
            AutomationProperties.SetName(box, label);
            return box;
        }

        public static Border Card(UIElement child, Brush? background = null, double padding = 12) => new()
        {
            Child = child,
            Background = background ?? Theme.Subtle,
            CornerRadius = new CornerRadius(8),
            Padding = new Thickness(padding),
            Margin = new Thickness(0, 0, 0, 8),
        };

        public static StackPanel Row(params UIElement[] children)
        {
            var row = new StackPanel { Orientation = Orientation.Horizontal };
            foreach (var child in children) row.Children.Add(child);
            return row;
        }

        public static StackPanel Column(double gap = 8, params UIElement[] children)
        {
            var column = new StackPanel { Orientation = Orientation.Vertical };
            foreach (var child in children)
            {
                if (child is FrameworkElement fe && fe.Margin == default) fe.Margin = new Thickness(0, 0, 0, gap);
                column.Children.Add(child);
            }
            return column;
        }
    }
}
