using System;
using System.Diagnostics;
using System.Linq;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Threading;

namespace Murmur
{
    /// <summary>Puts text at the caret: UI Automation, then clipboard paste, then typed characters.</summary>
    internal static class TextInserter
    {
        public static async Task<(bool ok, string method)> Insert(string text)
        {
            var element = await Uia.Run(() => AutomationElement.FocusedElement);
            if (element != null)
            {
                var secure = await Uia.Run(() => element.Current.IsPassword);
                if (secure) return (false, "clipboard");
                // ValuePattern replaces the whole value, so it is only safe for an empty field.
                var setByValue = await Uia.Run(() =>
                {
                    if (element.TryGetCurrentPattern(ValuePattern.Pattern, out var pattern) && pattern is ValuePattern value &&
                        !value.Current.IsReadOnly && string.IsNullOrEmpty(value.Current.Value))
                    {
                        value.SetValue(text);
                        return true;
                    }
                    return false;
                });
                if (setByValue) return (true, "automation");
            }
            if (await Paste(text)) return (true, "paste");
            if (text.Length <= 2000 && Type(text)) return (true, "typing");
            Clipboard.SetText(text);
            return (false, "clipboard");
        }

        /// <summary>Selects everything in the focused field (Ctrl+A), for the "select all" voice command.</summary>
        public static bool SelectAll() => Native.Send(
            Native.Key(Native.VK_CONTROL, false), Native.Key(Native.VK_A, false),
            Native.Key(Native.VK_A, true), Native.Key(Native.VK_CONTROL, true));

        /// <summary>Saves the clipboard, pastes with Ctrl+V and restores the clipboard 500 ms later.</summary>
        private static async Task<bool> Paste(string text)
        {
            IDataObject? saved = null;
            try { saved = Clipboard.GetDataObject(); } catch (System.Runtime.InteropServices.ExternalException) { }
            var copy = new DataObject();
            if (saved != null)
            {
                foreach (var format in saved.GetFormats(false))
                {
                    try { copy.SetData(format, saved.GetData(format, false)); } catch (Exception) { }
                }
            }
            try { Clipboard.SetText(text); } catch (System.Runtime.InteropServices.ExternalException) { return false; }
            var sent = Native.Send(
                Native.Key(Native.VK_CONTROL, false), Native.Key(Native.VK_V, false),
                Native.Key(Native.VK_V, true), Native.Key(Native.VK_CONTROL, true));
            await Task.Delay(500);
            try
            {
                if (Clipboard.ContainsText() && Clipboard.GetText() == text)
                {
                    if (copy.GetFormats().Length > 0) Clipboard.SetDataObject(copy, true);
                    else Clipboard.Clear();
                }
            }
            catch (System.Runtime.InteropServices.ExternalException) { }
            return sent;
        }

        private static bool Type(string text)
        {
            var inputs = text.SelectMany(c => new[] { Native.Unicode(c, false), Native.Unicode(c, true) }).ToArray();
            return inputs.Length == 0 || Native.Send(inputs);
        }
    }

    /// <summary>What the user is working in, captured at hotkey-down.</summary>
    internal static class ContextCapture
    {
        public static async Task<JsonObject> Capture()
        {
            var result = new JsonObject();
            var hwnd = Native.GetForegroundWindow();
            var title = new StringBuilder(512);
            Native.GetWindowText(hwnd, title, title.Capacity);
            result["windowTitle"] = title.ToString();
            Native.GetWindowThreadProcessId(hwnd, out var pid);
            try
            {
                using var process = Process.GetProcessById((int)pid);
                result["appId"] = process.ProcessName.ToLowerInvariant() + ".exe";
                result["appName"] = string.IsNullOrEmpty(process.MainWindowTitle) ? process.ProcessName : process.ProcessName;
            }
            catch (ArgumentException) { }

            var focused = await Uia.Run(() => AutomationElement.FocusedElement);
            if (focused != null)
            {
                var info = await Uia.Run(() =>
                {
                    var o = new JsonObject { ["role"] = focused.Current.ControlType.ProgrammaticName.Replace("ControlType.", "") };
                    if (focused.Current.IsPassword)
                    {
                        o["secure"] = true;
                        return o;
                    }
                    if (focused.TryGetCurrentPattern(TextPattern.Pattern, out var tp) && tp is TextPattern text)
                    {
                        var selection = text.GetSelection().FirstOrDefault()?.GetText(4000);
                        if (!string.IsNullOrEmpty(selection)) o["selection"] = selection;
                    }
                    if (focused.TryGetCurrentPattern(ValuePattern.Pattern, out var vp) && vp is ValuePattern value)
                    {
                        var v = value.Current.Value ?? "";
                        o["focusedText"] = v.Length > 4000 ? v[..4000] : v;
                    }
                    return o;
                });
                if (info != null) foreach (var pair in info) result[pair.Key] = pair.Value?.DeepClone();
            }
            var point = System.Windows.Forms.Cursor.Position;
            var under = await Uia.Run(() =>
            {
                var element = AutomationElement.FromPoint(new Point(point.X, point.Y));
                return element?.Current.Name;
            });
            if (!string.IsNullOrEmpty(under)) result["underPointer"] = under.Length > 4000 ? under[..4000] : under;
            return result;
        }
    }

    /// <summary>UI Automation calls can hang on a busy app, so each runs off the UI thread with a time limit.</summary>
    internal static class Uia
    {
        public static async Task<T?> Run<T>(Func<T> work, int timeoutMs = 800)
        {
            var task = Task.Run(() =>
            {
                try { return work(); }
                catch (Exception) { return default; }
            });
            var done = await Task.WhenAny(task, Task.Delay(timeoutMs));
            return done == task ? task.Result : default;
        }
    }
}
