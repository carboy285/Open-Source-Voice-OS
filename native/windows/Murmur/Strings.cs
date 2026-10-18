using System.Collections.Generic;
using System.Text.Json.Nodes;

namespace Murmur
{
    /// <summary>UI strings from the core's English and Japanese catalogs, shared with the macOS shell.</summary>
    public static class L
    {
        private static Dictionary<string, string> table = new();
        private static readonly Dictionary<string, string> Fallback = new()
        {
            ["app.name"] = "Murmur",
            ["menu.state.starting"] = "Starting",
            ["menu.quit"] = "Quit Murmur",
            ["error.core_stopped"] = "Murmur's engine stopped. Restarting…",
        };

        public static string Locale { get; private set; } = "en";

        public static void Load(JsonObject strings, string locale)
        {
            var next = new Dictionary<string, string>();
            foreach (var pair in strings) next[pair.Key] = pair.Value?.GetValue<string>() ?? pair.Key;
            table = next;
            Locale = locale;
        }

        public static string T(string key, params (string name, string value)[] values)
        {
            var text = table.TryGetValue(key, out var found) ? found : Fallback.TryGetValue(key, out var fallback) ? fallback : key;
            foreach (var (name, value) in values) text = text.Replace("{" + name + "}", value);
            return text;
        }

        public static string Count(string key, int count, params (string name, string value)[] values)
        {
            var plural = key + (count == 1 ? ".one" : ".other");
            var all = new List<(string, string)>(values) { ("count", count.ToString()) };
            return table.ContainsKey(plural) ? T(plural, all.ToArray()) : T(key, all.ToArray());
        }
    }
}
