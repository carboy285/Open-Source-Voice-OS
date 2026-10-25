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
    @State private var soulDraft = ""
    @State private var memoryFacts: [JSONObject] = []
    @State private var memoryPath = ""
    @State private var soulPath = ""
    @State private var memoryLoaded = false
    @State private var fact = ""
    @State private var factKind = "other"
    @State private var confirmClear = false

    private var shortcuts: [JSONObject] { model.settings["voice.shortcuts"] as? [JSONObject] ?? [] }
    private var profiles: [JSONObject] { model.settings["writing.profiles"] as? [JSONObject] ?? [] }
    private var memoryEnabled: Binding<Bool> {
        Binding(get: { model.settings["memory.enabled"] as? Bool ?? true }, set: { model.setSetting("memory.enabled", $0) })
    }
    private var memoryAuto: Binding<Bool> {
        Binding(get: { model.settings["memory.autoRemember"] as? Bool ?? true }, set: { model.setSetting("memory.autoRemember", $0) })
    }
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
            Section(L("memory.title")) {
                Text(L("memory.help")).font(.caption).foregroundStyle(.secondary)
                Toggle(L("memory.enabled"), isOn: memoryEnabled)
                Toggle(L("memory.auto"), isOn: memoryAuto).disabled(!(model.settings["memory.enabled"] as? Bool ?? true))
                Text(L("memory.auto.help")).font(.caption).foregroundStyle(.secondary)
                if memoryLoaded {
                    TextField(L("memory.soul"), text: $soulDraft, axis: .vertical).lineLimit(3...6)
                    HStack {
                        Button(L("approval.save")) { saveSoul() }
                        Button(L("memory.show_file")) { revealMemory() }
                        Spacer()
                        Button(L("memory.clear")) { confirmClear = true }.disabled(memoryFacts.isEmpty)
                    }
                    Text(L("memory.facts_count", ["count": String(memoryFacts.count)]))
                        .font(.caption).foregroundStyle(.secondary)
                    ForEach(memoryFacts.indices, id: \.self) { index in
                        let item = memoryFacts[index]
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item["text"] as? String ?? "")
                                Text(L("memory.kind.\(item["kind"] as? String ?? "other")"))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button(L("voice.remove")) { removeFact(item["id"] as? String ?? "") }
                        }
                    }
                    HStack {
                        TextField(L("memory.add"), text: $fact)
                        Picker(L("memory.kind"), selection: $factKind) {
                            Text(L("memory.kind.person")).tag("person")
                            Text(L("memory.kind.project")).tag("project")
                            Text(L("memory.kind.preference")).tag("preference")
                            Text(L("memory.kind.decision")).tag("decision")
                            Text(L("memory.kind.other")).tag("other")
                        }
                        .frame(width: 130)
                        Button(L("memory.add.button")) { addFact() }
                            .disabled(fact.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            }
            if let error { Text(error).foregroundStyle(.red) }
        }
        .formStyle(.grouped)
        .onAppear { loadMemory() }
        .alert(L("memory.clear"), isPresented: $confirmClear) {
            Button(L("memory.clear"), role: .destructive) { clearMemory() }
            Button(L("approval.cancel"), role: .cancel) {}
        } message: {
            Text(L("memory.clear.confirm"))
        }
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

    // MARK: Memory

    /// Memory lives in two files the core owns. Settings edits them through RPC so the files never cross the boundary.
    private func loadMemory() {
        model.core.request("memory.status") { result in
            if case let .success(value) = result { applyMemory(value) }
        }
    }

    private func applyMemory(_ value: Any) {
        guard let object = value as? JSONObject else { return }
        soulDraft = object["soul"] as? String ?? soulDraft
        memoryFacts = object["facts"] as? [JSONObject] ?? []
        memoryPath = object["path"] as? String ?? memoryPath
        soulPath = object["soulPath"] as? String ?? soulPath
        memoryLoaded = true
    }

    private func saveSoul() {
        model.core.request("memory.soul.set", ["text": soulDraft]) { result in
            switch result {
            case let .success(value): applyMemory(value)
            case let .failure(failure): error = failure.localizedDescription
            }
        }
    }

    private func addFact() {
        let text = fact.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        model.core.request("memory.add", ["text": text, "kind": factKind]) { result in
            switch result {
            case let .success(value):
                applyMemory(value)
                fact = ""
            case let .failure(failure): error = failure.localizedDescription
            }
        }
    }

    private func removeFact(_ id: String) {
        guard !id.isEmpty else { return }
        model.core.request("memory.remove", ["id": id]) { result in
            if case let .success(value) = result { applyMemory(value) }
        }
    }

    private func clearMemory() {
        model.core.request("memory.clear") { result in
            if case let .success(value) = result { applyMemory(value) }
        }
    }

    private func revealMemory() {
        let files = [soulPath, memoryPath].filter { !$0.isEmpty }.map { URL(fileURLWithPath: $0) }
        guard !files.isEmpty else { return }
        NSWorkspace.shared.activateFileViewerSelecting(files)
    }
}
