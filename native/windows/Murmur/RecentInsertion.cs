using System;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Automation;
using System.Windows.Automation.Text;

namespace Murmur
{
    internal static class RecentInsertion
    {
        private static AutomationElement? element;
        private static string value = "", text = "";
        private static TextPatternRange? caret;

        public static async Task Remember(string inserted, bool ok)
        {
            element = null; caret = null;
            if (!ok || inserted.Length == 0) return;
            await Uia.Run(() =>
            {
                var focused = AutomationElement.FocusedElement;
                if (focused == null || focused.Current.IsPassword || !focused.TryGetCurrentPattern(TextPattern.Pattern, out var pattern) || pattern is not TextPattern tp) return false;
                var selection = tp.GetSelection().FirstOrDefault();
                if (selection == null || selection.GetText(-1).Length != 0) return false;
                var span = selection.Clone();
                span.MoveEndpointByUnit(TextPatternRangeEndpoint.Start, TextUnit.Character, -inserted.Length);
                if (span.GetText(-1) != inserted) return false;
                element = focused; value = tp.DocumentRange.GetText(-1); text = inserted; caret = selection.Clone();
                return true;
            });
        }

        public static async Task<bool> Replace(string expected, string replacement)
        {
            var selected = await Uia.Run(() =>
            {
                var focused = AutomationElement.FocusedElement;
                if (expected != text || element == null || caret == null || focused == null || !Automation.Compare(element, focused) || focused.Current.IsPassword ||
                    !focused.TryGetCurrentPattern(TextPattern.Pattern, out var pattern) || pattern is not TextPattern tp || tp.DocumentRange.GetText(-1) != value) return false;
                var current = tp.GetSelection().FirstOrDefault();
                if (current == null || !current.Compare(caret)) return false;
                var span = current.Clone();
                span.MoveEndpointByUnit(TextPatternRangeEndpoint.Start, TextUnit.Character, -expected.Length);
                if (span.GetText(-1) != expected) return false;
                span.Select();
                return true;
            });
            if (!selected) return false;
            if (replacement.Length == 0)
            {
                // The selected range was verified above. Empty clipboard text cannot delete a selection.
                var deleted = Native.Send(Native.Key(0x08, false), Native.Key(0x08, true));
                element = null; caret = null;
                return deleted;
            }
            var (ok, _) = await TextInserter.Insert(replacement);
            await Remember(replacement, ok);
            return ok;
        }
    }
}
