import AppKit
import SwiftUI

struct PersonalizationSettings: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var strings: Strings
    @State private var phrase = ""
    @State private var content = ""
    @State private var kind = "text"
    @State private var name = ""
    @State private var instructions = ""
    @State private var apps = ""
    @State private var error: String?
    @State private var editingPhrase: String?
    @State private var editingProfile: String?

    private var shortcuts: [JSONObject] { model.settings["voice.shortcuts"] as? [JSONObject] ?? [] }
    private var profiles: [JSONObject] { model.settings["writing.profiles"] as? [JSONObject] ?? [] }
    private func setting(_ key: String, fallback: String = "") -> Binding<String> {
        Binding(get: { model.settings[key] as? String ?? fallback }, set: { model.setSetting(key, $0) })
    }

    var body: some View {
        Form {
            if !model.llmReady { Text(L("profiles.needs_ai")).font(.caption).foregroundStyle(.secondary) }
            Section(L("voice.title")) {
                Text(L("voice.help")).font(.caption).foregroundStyle(.secondary)
                ForEach(shortcuts.indices, id: \.self) { index in
                    let item = shortcuts[index]
                    HStack {
                        VStack(alignment: .leading) {
                            Text(item["phrase"] as? String ?? "").fontWeight(.medium)
                            Text(item["content"] as? String ?? "").lineLimit(2).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button(L("approval.edit")) {
                            phrase = item["phrase"] as? String ?? ""; content = item["content"] as? String ?? ""
                            kind = item["kind"] as? String ?? "text"; editingPhrase = phrase
                        }
                        Button(L("voice.remove")) { var items = shortcuts; items.remove(at: index); model.setSetting("voice.shortcuts", items) }
                    }
                }
                TextField(L("voice.phrase"), text: $phrase)
                Picker(L("voice.kind"), selection: $kind) {
                    Text(L("voice.kind.text")).tag("text")
                    Text(L("voice.kind.task")).tag("task")
                }
                TextField(L(kind == "text" ? "voice.content" : "voice.task"), text: $content, axis: .vertical).lineLimit(2...4)
                if editingPhrase != nil { Button(L("profiles.cancel")) { editingPhrase = nil; phrase = ""; content = "" } }
                Button(L("approval.save")) { saveShortcut() }.disabled(phrase.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            Section(L("profiles.title")) {
                Text(L("profiles.help")).font(.caption).foregroundStyle(.secondary)
                Picker(L("profiles.active"), selection: setting("writing.activeProfile")) {
                    Text(L("profiles.default")).tag("")
                    ForEach(profiles.indices, id: \.self) { index in
                        Text(profileName(profiles[index])).tag(profiles[index]["id"] as? String ?? "")
                    }
                }
                ForEach(profiles.indices, id: \.self) { index in
                    let item = profiles[index]
                    HStack {
                        Text(profileName(item))
                        Spacer()
                        Button(L("approval.edit")) {
                            editingProfile = item["id"] as? String; name = profileName(item)
                            instructions = item["instructions"] as? String ?? ""
                            apps = (item["appIds"] as? [String] ?? []).joined(separator: ", ")
                        }
                        Button(L("voice.remove")) { var items = profiles; items.remove(at: index); model.setSetting("writing.profiles", items) }
                    }
                }
                TextField(L("profiles.name"), text: $name)
                TextField(L("profiles.instructions"), text: $instructions, axis: .vertical).lineLimit(2...4)
                Menu(L("profiles.choose_app")) {
                    ForEach(NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && $0.bundleIdentifier != nil }.sorted { ($0.localizedName ?? "") < ($1.localizedName ?? "") }, id: \.processIdentifier) { app in
                        Button(app.localizedName ?? app.bundleIdentifier ?? "") {
                            guard let id = app.bundleIdentifier else { return }
                            let ids = apps.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                            if !ids.contains(id) { apps = (ids + [id]).joined(separator: ", ") }
                        }
                    }
                }
                TextField(L("profiles.apps"), text: $apps)
                Text(L("profiles.apps.help")).font(.caption).foregroundStyle(.secondary)
                if editingProfile != nil { Button(L("profiles.cancel")) { editingProfile = nil; name = ""; instructions = ""; apps = "" } }
                Button(L("approval.save")) { saveProfile() }.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            Section(L("translation.title")) {
                Picker(L("translation.mode"), selection: setting("dictation.outputMode", fallback: "original")) {
                    Text(L("translation.original")).tag("original")
                    Text(L("translation.translate")).tag("translate")
                }
                Picker(L("translation.language"), selection: setting("dictation.targetLanguage", fallback: "en")) {
                    ForEach(["en", "es", "fr", "de", "it", "pt", "ja", "ko", "zh", "nl", "uk"], id: \.self) { code in Text(L("language.\(code)")).tag(code) }
                }
                Text(L("translation.help")).font(.caption).foregroundStyle(.secondary)
            }
            Section(L("voice.corrections")) { Text(L("voice.corrections.help")).font(.callout).foregroundStyle(.secondary) }
            if let error { Text(error).foregroundStyle(.red) }
        }
        .formStyle(.grouped)
    }

    private func profileName(_ item: JSONObject) -> String {
        let id = item["id"] as? String ?? ""
        let name = item["name"] as? String ?? ""
        return ["work": "Work", "friends": "Friends", "concise": "Concise"][id] == name ? L("profiles.\(id)") : name
    }

    private func save(_ key: String, _ items: [JSONObject], done: @escaping () -> Void) {
        error = nil
        model.core.request("settings.set", ["key": key, "value": items]) { result in
            switch result {
            case .success: model.refreshSettings(); done()
            case let .failure(failure): error = failure.localizedDescription
            }
        }
    }

    private func saveShortcut() {
        var items = shortcuts.filter { $0["phrase"] as? String != editingPhrase }
        items.append(["phrase": phrase, "kind": kind, "content": content])
        save("voice.shortcuts", items) { phrase = ""; content = ""; editingPhrase = nil }
    }

    private func saveProfile() {
        let id = editingProfile ?? UUID().uuidString
        var items = profiles.filter { $0["id"] as? String != id }
        items.append(["id": id, "name": name, "instructions": instructions, "appIds": apps.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }])
        save("writing.profiles", items) { name = ""; instructions = ""; apps = ""; editingProfile = nil }
    }
}
