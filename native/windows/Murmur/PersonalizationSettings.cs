using System;
using System.Linq;
using System.Text.Json.Nodes;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;

namespace Murmur
{
    internal sealed partial class SettingsWindow
    {
        private UIElement Personalization()
        {
            var column = Ui.Column(8);
            var error = Ui.Text("", Theme.Caption);
            error.Foreground = Theme.Warning;
            var shortcuts = (app.Settings["voice.shortcuts"] as JsonArray)?.DeepClone() as JsonArray ?? new JsonArray();
            var profiles = (app.Settings["writing.profiles"] as JsonArray)?.DeepClone() as JsonArray ?? new JsonArray();
            var phrase = Ui.Input("", L.T("voice.phrase"));
            var content = Ui.Input("", L.T("voice.content")); content.AcceptsReturn = true; content.MinHeight = 64;
            var kind = new ComboBox { ItemsSource = new[] { L.T("voice.kind.text"), L.T("voice.kind.task") }, SelectedIndex = 0 };
            AutomationProperties.SetName(kind, L.T("voice.kind"));
            string? editingPhrase = null, editingProfile = null;
            column.Children.Add(Ui.Text(L.T("voice.title"), Theme.Subtitle, FontWeights.SemiBold));
            column.Children.Add(Ui.Text(L.T("voice.help"), secondary: true));
            foreach (var item in shortcuts.OfType<JsonObject>().ToArray())
            {
                var spoken = item.Str("phrase");
                column.Children.Add(Ui.Card(Ui.Column(4, Ui.Text(spoken, Theme.Body, FontWeights.SemiBold), Ui.Text(item.Str("content"), Theme.Caption, secondary: true), Ui.Row(
                    Ui.Button(L.T("approval.edit"), () => { editingPhrase = spoken; phrase.Text = spoken; content.Text = item.Str("content"); kind.SelectedIndex = item.Str("kind") == "task" ? 1 : 0; }),
                    Ui.Button(L.T("voice.remove"), () => { shortcuts.Remove(item); SavePersonalization("voice.shortcuts", shortcuts, error); })))));
            }
            column.Children.Add(Ui.Text(L.T("voice.phrase"))); column.Children.Add(phrase);
            column.Children.Add(kind); column.Children.Add(Ui.Text(L.T("voice.content"))); column.Children.Add(content);
            column.Children.Add(Ui.Button(L.T("approval.save"), () =>
            {
                if (string.IsNullOrWhiteSpace(phrase.Text) || string.IsNullOrWhiteSpace(content.Text)) { error.Text = L.T("voice.required"); return; }
                var items = new JsonArray(shortcuts.OfType<JsonObject>().Where(i => i.Str("phrase") != editingPhrase).Select(i => i.DeepClone()).ToArray());
                items.Add(new JsonObject { ["phrase"] = phrase.Text, ["content"] = content.Text, ["kind"] = kind.SelectedIndex == 1 ? "task" : "text" });
                SavePersonalization("voice.shortcuts", items, error);
            }));
            column.Children.Add(Ui.Text(L.T("profiles.title"), Theme.Subtitle, FontWeights.SemiBold));
            column.Children.Add(Ui.Text(L.T("profiles.help"), secondary: true));
            var profilePicker = new ComboBox();
            AutomationProperties.SetName(profilePicker, L.T("profiles.active"));
            profilePicker.Items.Add(L.T("profiles.default"));
            foreach (var p in profiles) profilePicker.Items.Add(ProfileName(p));
            profilePicker.SelectedIndex = 1 + Array.FindIndex(profiles.ToArray(), p => p.Str("id") == app.Settings.Str("writing.activeProfile"));
            profilePicker.SelectionChanged += (_, _) => app.SetSetting("writing.activeProfile", profilePicker.SelectedIndex <= 0 ? "" : profiles[profilePicker.SelectedIndex - 1].Str("id"));
            column.Children.Add(profilePicker);
            var name = Ui.Input("", L.T("profiles.name"));
            var instructions = Ui.Input("", L.T("profiles.instructions")); instructions.AcceptsReturn = true; instructions.MinHeight = 64;
            var apps = Ui.Input("", L.T("profiles.apps"));
            foreach (var item in profiles.OfType<JsonObject>().ToArray())
            {
                column.Children.Add(Ui.Row(Ui.Text(ProfileName(item)),
                    Ui.Button(L.T("approval.edit"), () => { editingProfile = item.Str("id"); name.Text = ProfileName(item); instructions.Text = item.Str("instructions"); apps.Text = string.Join(", ", (item["appIds"] as JsonArray ?? new JsonArray()).Select(i => i?.GetValue<string>() ?? "")); }),
                    Ui.Button(L.T("voice.remove"), () => { profiles.Remove(item); SavePersonalization("writing.profiles", profiles, error); })));
            }
            column.Children.Add(Ui.Text(L.T("profiles.name"))); column.Children.Add(name);
            column.Children.Add(Ui.Text(L.T("profiles.instructions"))); column.Children.Add(instructions);
            column.Children.Add(Ui.Text(L.T("profiles.apps"))); column.Children.Add(apps);
            column.Children.Add(Ui.Text(L.T("profiles.apps.help"), Theme.Caption, secondary: true));
            column.Children.Add(Ui.Button(L.T("approval.save"), () =>
            {
                if (string.IsNullOrWhiteSpace(name.Text) || string.IsNullOrWhiteSpace(instructions.Text)) { error.Text = L.T("profiles.name_required"); return; }
                var id = editingProfile ?? Guid.NewGuid().ToString();
                var items = new JsonArray(profiles.OfType<JsonObject>().Where(i => i.Str("id") != id).Select(i => i.DeepClone()).ToArray());
                items.Add(new JsonObject { ["id"] = id, ["name"] = name.Text, ["instructions"] = instructions.Text,
                    ["appIds"] = new JsonArray(apps.Text.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Select(a => (JsonNode?)JsonValue.Create(a)).ToArray()) });
                SavePersonalization("writing.profiles", items, error);
            }));
            column.Children.Add(Ui.Text(L.T("translation.title"), Theme.Subtitle, FontWeights.SemiBold));
            var mode = new ComboBox { ItemsSource = new[] { L.T("translation.original"), L.T("translation.translate") }, SelectedIndex = app.Settings.Str("dictation.outputMode") == "translate" ? 1 : 0 };
            AutomationProperties.SetName(mode, L.T("translation.mode"));
            mode.SelectionChanged += (_, _) => app.SetSetting("dictation.outputMode", mode.SelectedIndex == 1 ? "translate" : "original");
            column.Children.Add(mode);
            string[] codes = { "en", "es", "fr", "de", "it", "pt", "ja", "ko", "zh", "nl", "uk" };
            var language = new ComboBox { ItemsSource = codes.Select(c => L.T("language." + c)), SelectedIndex = Math.Max(0, Array.IndexOf(codes, app.Settings.Str("dictation.targetLanguage", "en"))) };
            AutomationProperties.SetName(language, L.T("translation.language"));
            language.SelectionChanged += (_, _) => app.SetSetting("dictation.targetLanguage", codes[language.SelectedIndex]);
            column.Children.Add(language); column.Children.Add(Ui.Text(L.T("translation.help"), Theme.Caption, secondary: true));
            column.Children.Add(Ui.Text(L.T("voice.corrections"), Theme.Subtitle, FontWeights.SemiBold));
            column.Children.Add(Ui.Text(L.T("voice.corrections.help"), secondary: true));
            column.Children.Add(error);
            return column;
        }

        private static string ProfileName(JsonNode? item)
        {
            var original = item.Str("id") switch { "work" => "Work", "friends" => "Friends", "concise" => "Concise", _ => "" };
            return original.Length > 0 && original == item.Str("name") ? L.T("profiles." + item.Str("id")) : item.Str("name");
        }

        private async void SavePersonalization(string key, JsonArray items, TextBlock error)
        {
            try { await app.Core.Request("settings.set", new JsonObject { ["key"] = key, ["value"] = items.DeepClone() }); await app.RefreshSettings(); Rebuild(); }
            catch (Exception failure) { error.Text = failure.Message; }
        }
    }
}
