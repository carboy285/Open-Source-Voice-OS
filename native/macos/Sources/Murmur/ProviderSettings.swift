import SwiftUI

/// A key box for one service. The key goes to the Keychain on Return, when the field loses focus, or when the tab closes.
/// It is never shown again, only "a key is saved".
struct KeyField: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var strings: Strings
    /// "llm", "stt" or "tts".
    let kind: String
    let service: String
    let keyUrl: String
    /// A server on your own network may need no key at all.
    var keyIsOptional = false
    @State private var key = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            HStack {
                SecureField(keyIsOptional ? L("settings.key.optional") : L("settings.llm.api_key"), text: $key)
                    .focused($focused)
                    .onSubmit(commit)
                Button(L("approval.save"), action: commit)
            }
            HStack(spacing: Space.m) {
                if let error = model.apiKeyError {
                    Text(error).font(.caption).foregroundStyle(.red)
                } else if model.hasKey(kind: kind, id: service) {
                    Label(L("settings.llm.key_saved"), systemImage: "key.fill").font(.caption).foregroundStyle(.secondary)
                    Button(L("settings.key.remove")) { model.saveProviderKey(kind: kind, id: service, key: "") }
                        .buttonStyle(.link)
                        .font(.caption)
                }
                if let url = URL(string: keyUrl), !keyUrl.isEmpty {
                    Link(L("settings.key.get"), destination: url).font(.caption)
                }
            }
        }
        .id("\(kind)-\(service)")
        .onChange(of: focused) { isFocused in
            if !isFocused { commit() }
        }
        .onDisappear(perform: commit)
    }

    private func commit() {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        model.saveProviderKey(kind: kind, id: service, key: trimmed)
        key = ""
    }
}

/// Binding to a text setting stored in the core.
private func setting(_ model: AppModel, _ key: String) -> Binding<String> {
    Binding(get: { model.settings[key] as? String ?? "" }, set: { model.setSetting(key, $0) })
}

/// Where dictation is recognised: the models on this Mac (the default, private) or a hosted service with your own key.
/// Choosing a hosted service has to be confirmed, because from then on your recordings are sent to it.
struct CloudSpeechSection: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var strings: Strings
    @State private var pending: String?

    private var current: String { model.settings["stt.provider"] as? String ?? "" }
    private func service(_ id: String?) -> ServiceInfo? { model.catalog.stt.first { $0.id == id } }

    var body: some View {
        Section {
            Picker(L("settings.cloud_stt.where"), selection: Binding(get: { current }, set: choose)) {
                Text(L("settings.cloud_stt.local")).tag("")
                ForEach(model.catalog.stt) { Text($0.name).tag($0.id) }
            }
            if let chosen = service(current) {
                let ownServer = chosen.id == "custom" || chosen.id == "nvidia"
                TextField(L("settings.llm.model"), text: setting(model, "stt.model.cloud"), prompt: Text(chosen.defaultModel))
                if ownServer {
                    TextField(L("settings.llm.base_url"), text: setting(model, "stt.baseUrl"), prompt: Text(chosen.url))
                }
                KeyField(kind: "stt", service: chosen.id, keyUrl: chosen.keyUrl, keyIsOptional: ownServer)
                Text(L("settings.cloud_stt.privacy", ["name": chosen.name])).font(.caption).foregroundStyle(.orange)
            }
        } header: {
            Text(L("settings.cloud_stt.title"))
        } footer: {
            Text(L("settings.cloud_stt.help")).font(.caption).foregroundStyle(.secondary)
        }
        .onAppear { model.refreshProviders() }
        .alert(
            L("settings.cloud_stt.confirm.title"),
            isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } })
        ) {
            Button(L("settings.cloud_stt.confirm.button")) {
                if let id = pending {
                    model.setSetting("stt.provider", id)
                    model.setSetting("stt.model.cloud", "")
                }
                pending = nil
            }
            Button(L("approval.cancel"), role: .cancel) { pending = nil }
        } message: {
            Text(L("settings.cloud_stt.confirm.body", ["name": service(pending)?.name ?? ""]))
        }
    }

    private func choose(_ id: String) {
        if id.isEmpty { model.setSetting("stt.provider", "") } else if id != current { pending = id }
    }
}

/// Which voice reads replies aloud: this Mac's own (the default, private) or a hosted service with your own key.
struct CloudVoiceRows: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var strings: Strings
    @State private var pending: String?

    private var current: String { model.settings["tts.provider"] as? String ?? "" }
    private func service(_ id: String?) -> ServiceInfo? { model.catalog.tts.first { $0.id == id } }

    var body: some View {
        Group {
            Picker(L("settings.tts.engine"), selection: Binding(get: { current }, set: choose)) {
                Text(L("settings.tts.engine.system")).tag("")
                ForEach(model.catalog.tts) { Text($0.name).tag($0.id) }
            }
            if let chosen = service(current) {
                TextField(L("settings.llm.model"), text: setting(model, "tts.model"), prompt: Text(chosen.defaultModel))
                TextField(L("settings.tts.cloud_voice"), text: setting(model, "tts.cloudVoice"), prompt: Text(chosen.defaultVoice))
                if chosen.id == "custom" {
                    TextField(L("settings.llm.base_url"), text: setting(model, "tts.baseUrl"), prompt: Text("http://localhost:8880/v1/audio/speech"))
                }
                KeyField(kind: "tts", service: chosen.id, keyUrl: chosen.keyUrl, keyIsOptional: chosen.id == "custom")
                Text(L("settings.tts.privacy", ["name": chosen.name])).font(.caption).foregroundStyle(.orange)
            }
        }
        .onAppear { model.refreshProviders() }
        .alert(
            L("settings.tts.confirm.title"),
            isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } })
        ) {
            Button(L("settings.tts.confirm.button")) {
                if let id = pending {
                    model.setSetting("tts.provider", id)
                    model.setSetting("tts.model", "")
                    model.setSetting("tts.cloudVoice", "")
                }
                pending = nil
            }
            Button(L("approval.cancel"), role: .cancel) { pending = nil }
        } message: {
            Text(L("settings.tts.confirm.body", ["name": service(pending)?.name ?? ""]))
        }
    }

    private func choose(_ id: String) {
        if id.isEmpty { model.setSetting("tts.provider", "") } else if id != current { pending = id }
    }
}
