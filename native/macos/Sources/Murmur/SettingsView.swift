import AppKit
import SwiftUI

/// The Settings window size. Six tabs need about 700 pt for the tab bar to show them all; narrower and macOS folds
/// the last ones into a ">>" menu.
enum SettingsLayout {
    static let width: CGFloat = 800
    static let height: CGFloat = 480
}

struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var strings: Strings

    var body: some View {
        TabView {
            GeneralSettings().tabItem { Label(L("settings.tab.general"), systemImage: "gearshape") }
            DictationSettings().tabItem { Label(L("settings.tab.dictation"), systemImage: "waveform") }
            AgentSettings().tabItem { Label(L("settings.tab.agent"), systemImage: "sparkles") }
            ConnectorSettings().tabItem { Label(L("settings.tab.connectors"), systemImage: "puzzlepiece.extension") }
            AppsSettings().tabItem { Label(L("settings.tab.apps"), systemImage: "square.grid.2x2") }
            PrivacySettings().tabItem { Label(L("settings.tab.privacy"), systemImage: "hand.raised") }
        }
        .padding(Space.l)
        .frame(width: SettingsLayout.width, height: SettingsLayout.height)
    }
}

/// Binding to a boolean setting stored in the core.
private func flag(_ model: AppModel, _ key: String, default value: Bool = false) -> Binding<Bool> {
    Binding(get: { model.settings[key] as? Bool ?? value }, set: { model.setSetting(key, $0) })
}

private func text(_ model: AppModel, _ key: String) -> Binding<String> {
    Binding(get: { model.settings[key] as? String ?? "" }, set: { model.setSetting(key, $0) })
}

struct GeneralSettings: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var strings: Strings
    @State private var launch = AppModel.shared.launchAtLogin

    var body: some View {
        Form {
            ApprovalModeSection()
            Picker(L("settings.language"), selection: Binding(
                get: { model.settings["ui.locale"] as? String ?? "system" },
                set: { model.setLocale($0) }
            )) {
                Text(L("settings.language.system")).tag("system")
                Text("English").tag("en")
                Text("日本語").tag("ja")
            }
            Toggle(L("settings.sound"), isOn: flag(model, "sound.enabled", default: true))
            Toggle(L("settings.launch_at_login"), isOn: Binding(get: { launch }, set: { launch = $0; model.setLaunchAtLogin($0) }))
            Toggle(L("settings.updates"), isOn: Binding(
                get: { UserDefaults.standard.object(forKey: "autoUpdate") as? Bool ?? true },
                set: { UserDefaults.standard.set($0, forKey: "autoUpdate") }
            ))
            UpdateSettingsSection(updater: model.updater)
            Section {
                LabeledContent(L("settings.hotkey.dictate"), value: model.hotkeyName)
                LabeledContent(L("settings.hotkey.agent"), value: "\(model.hotkeyName) + Shift")
                LabeledContent(L("settings.hotkey.edit"), value: "\(model.hotkeyName) + Command")
            }
        }
        .formStyle(.grouped)
    }
}

/// How much Murmur asks before it acts: everything, only risky things, or nothing. "Ask" is the default, and
/// Full access has to be confirmed because it removes the preview for every action.
struct ApprovalModeSection: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var strings: Strings
    @State private var confirmFull = false

    private var mode: String {
        let value = model.settings["approval.mode"] as? String ?? "ask"
        return value == "auto" || value == "full" ? value : "ask"
    }

    var body: some View {
        Section(L("settings.approval.title")) {
            option("ask", icon: "hand.raised", tint: nil)
            option("auto", icon: "checkmark.shield", tint: nil)
            option("full", icon: "exclamationmark.shield", tint: .orange)
        }
        .alert(L("settings.approval.full.confirm.title"), isPresented: $confirmFull) {
            Button(L("settings.approval.full.confirm.button"), role: .destructive) { model.setSetting("approval.mode", "full") }
            Button(L("approval.cancel"), role: .cancel) {}
        } message: {
            Text(L("settings.approval.full.confirm.body"))
        }
    }

    private func option(_ value: String, icon: String, tint: Color?) -> some View {
        Button {
            if value == "full" && mode != "full" { confirmFull = true } else { model.setSetting("approval.mode", value) }
        } label: {
            HStack(alignment: .top, spacing: Space.m) {
                Image(systemName: icon).frame(width: 24).foregroundStyle(tint ?? Color.primary).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(L("settings.approval.\(value)")).font(.body.weight(.medium)).foregroundStyle(tint ?? Color.primary)
                    Text(L("settings.approval.\(value).help")).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if mode == value { Image(systemName: "checkmark").accessibilityHidden(true) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(mode == value ? .isSelected : [])
    }
}

struct DictationSettings: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var strings: Strings

    var body: some View {
        Form {
            Toggle(L("settings.toggle_mode"), isOn: flag(model, "dictation.toggleMode"))
            Toggle(L("settings.spoken_punctuation"), isOn: flag(model, "dictation.spokenPunctuation"))
            Toggle(L("settings.learning"), isOn: flag(model, "dictation.learning", default: true))
            SpeechEngineSection(store: model.speech) {
                pathRow(L("settings.stt.binary"), key: "stt.binary", directories: false)
                pathRow(L("settings.stt.model"), key: "stt.model", directories: false)
            }
        }
        .formStyle(.grouped)
    }

    private func pathRow(_ label: String, key: String, directories: Bool) -> some View {
        PathRow(label: label, key: key, directories: directories, startIn: key == "stt.binary" ? "/opt/homebrew/bin" : nil)
    }
}

/// Engine choice, then NVIDIA models to download (Parakeet) or the whisper.cpp paths.
struct SpeechEngineSection<WhisperRows: View>: View {
    @ObservedObject var store: SpeechModelStore
    @EnvironmentObject var strings: Strings
    private let whisperRows: () -> WhisperRows

    init(store: SpeechModelStore, @ViewBuilder whisperRows: @escaping () -> WhisperRows) {
        self.store = store
        self.whisperRows = whisperRows
    }

    var body: some View {
        Section {
            Picker(L("settings.stt.engine"), selection: Binding(get: { store.engine }, set: { store.setEngine($0) })) {
                Text(L("settings.stt.engine.parakeet")).tag("parakeet")
                Text(L("settings.stt.engine.whisper")).tag("whisper")
            }
            if store.engine == "parakeet" {
                if !store.ready {
                    Text(L("models.none")).font(.callout).foregroundStyle(.orange)
                }
                ForEach(store.models) { info in
                    SpeechModelRow(info: info, store: store)
                }
            } else {
                whisperRows()
            }
        } footer: {
            if store.engine == "parakeet" {
                VStack(alignment: .leading, spacing: Space.xs) {
                    Text(L("models.languages"))
                    if !store.directory.isEmpty { Text(L("models.location", ["path": store.directory])) }
                    Text(L("models.attribution"))
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
        .onAppear { store.refresh() }
    }
}

/// A path setting with a picker. Shows an error under the row when the choice could not be saved.
struct PathRow: View {
    @EnvironmentObject var model: AppModel
    let label: String
    let key: String
    let directories: Bool
    let startIn: String?
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            HStack {
                TextField(label, text: text(model, key))
                Button(L("settings.stt.choose"), action: choose)
            }
            if let error {
                Text(error).font(.caption).foregroundStyle(.red)
            }
        }
    }

    private func choose() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = !directories
        panel.canChooseDirectories = directories
        panel.allowsMultipleSelection = false
        // Keep /opt/homebrew/bin/whisper-cli instead of its versioned Cellar target, so upgrades don't break the path.
        panel.resolvesAliases = false
        panel.showsHiddenFiles = true
        if let startIn, FileManager.default.fileExists(atPath: startIn) {
            panel.directoryURL = URL(fileURLWithPath: startIn, isDirectory: true)
        }
        // A menu-bar app is often not active; the panel would open behind other windows.
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        error = nil
        model.savePath(key, url.path) { message in error = message }
    }
}

struct AgentSettings: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var strings: Strings
    @State private var apiKey = ""
    @State private var rate = 0.5
    @State private var voices = Speaker.choices()
    @FocusState private var keyFocused: Bool

    private var provider: String { model.settings["llm.provider"] as? String ?? "none" }

    var body: some View {
        Form {
            Picker(L("settings.llm.provider"), selection: Binding(get: { provider }, set: { model.setSetting("llm.provider", $0) })) {
                Text(L("settings.llm.none")).tag("none")
                Text(L("settings.llm.anthropic")).tag("anthropic")
                Text(L("settings.llm.openai")).tag("openai-compatible")
                Text(L("settings.llm.chatgpt")).tag("chatgpt")
            }
            if provider == "chatgpt" {
                TextField(L("settings.llm.model"), text: text(model, "llm.model"))
                ChatGptSection()
            } else if provider != "none" {
                TextField(L("settings.llm.model"), text: text(model, "llm.model"))
                if provider == "openai-compatible" {
                    TextField(L("settings.llm.base_url"), text: text(model, "llm.baseUrl"))
                    Toggle(L("settings.llm.vision"), isOn: flag(model, "llm.vision"))
                }
                HStack {
                    SecureField(L("settings.llm.api_key"), text: $apiKey)
                        .focused($keyFocused)
                        .onSubmit(commitKey)
                    Button(L("approval.save"), action: commitKey)
                }
                if let error = model.apiKeyError {
                    Text(error).font(.caption).foregroundStyle(.red)
                } else if model.apiKeySaved {
                    Label(L("settings.llm.key_saved"), systemImage: "key.fill").font(.caption).foregroundStyle(.secondary)
                }
            }
            if !model.llmReady {
                Text(L("settings.llm.missing")).font(.callout).foregroundStyle(.orange)
            }
            Section(L("settings.circle.title")) {
                Toggle(L("settings.circle.enabled", ["key": "\(model.hotkeyName) + Control"]), isOn: flag(model, "circle.enabled", default: true))
                Toggle(L("settings.screen.attach"), isOn: flag(model, "screen.attach"))
                Text(L("settings.circle.help")).font(.caption).foregroundStyle(.secondary)
                if Permissions.screenRecording != .granted {
                    HStack {
                        Text(L("settings.circle.permission")).font(.caption).foregroundStyle(.orange)
                        Button(L("settings.circle.allow")) {
                            Permissions.requestScreenRecording()
                            Permissions.openSettings("Privacy_ScreenCapture")
                        }
                    }
                }
            }
            Section(L("settings.tts.title")) {
                Toggle(L("settings.tts.enabled"), isOn: flag(model, "tts.enabled", default: true))
                Picker(L("settings.tts.voice"), selection: text(model, "tts.voice")) {
                    Text(L("settings.tts.voice.auto")).tag("")
                    ForEach(voices) { Text($0.label).tag($0.id) }
                }
                Slider(
                    value: $rate,
                    in: 0.2...0.8,
                    label: { Text(L("settings.tts.rate")) },
                    onEditingChanged: { editing in
                        if !editing { model.setSetting("tts.rate", rate) }
                    }
                )
                HStack {
                    Button(L("settings.tts.test")) { model.speakSample() }
                    Text(L("settings.tts.help")).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .formStyle(.grouped)
        .onAppear { rate = model.settings["tts.rate"] as? Double ?? 0.5 }
        .onChange(of: keyFocused) { focused in
            if !focused { commitKey() }
        }
        .onDisappear(perform: commitKey)
    }

    /// Saves a typed key on Return, when the field loses focus, or when the tab closes, not only on the button.
    private func commitKey() {
        let key = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { return }
        model.saveApiKey(key)
        apiKey = ""
    }
}

struct ConnectorSettings: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var strings: Strings

    var body: some View {
        Form {
            Section {
                ForEach(model.connectors) { connector in
                    HStack(alignment: .top, spacing: Space.m) {
                        Image(systemName: symbol(forIcon: connector.icon)).frame(width: 24).accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(connector.name).font(.body.weight(.medium))
                            Text(connector.description).font(.caption).foregroundStyle(.secondary)
                            if connector.skeleton {
                                Text(L("settings.connectors.skeleton")).font(.caption).foregroundStyle(.orange)
                            }
                            if connector.id == "computer", connector.enabled, Permissions.accessibility != .granted {
                                HStack {
                                    Text(L("settings.computer.permission")).font(.caption).foregroundStyle(.orange)
                                    Button(L("settings.circle.allow")) { Permissions.openSettings("Privacy_Accessibility") }
                                }
                            }
                            if connector.id == "obsidian" { folderButton(connector.id, key: "vaultPath") }
                            if connector.id == "files" { folderButton(connector.id, key: "roots") }
                            if connector.auth == "oauth2-pkce", connector.enabled {
                                Button(L("settings.connectors.connect")) { model.connect(connector.id) }.buttonStyle(.link)
                            }
                        }
                        Spacer()
                        Toggle(L("settings.connectors.on"), isOn: Binding(get: { connector.enabled }, set: { model.setConnector(connector.id, enabled: $0) }))
                            .labelsHidden()
                            .accessibilityLabel(connector.name)
                    }
                }
            }
            Section(L("settings.agents.title")) {
                ForEach(model.codingAgents) { agent in
                    HStack(alignment: .top, spacing: Space.m) {
                        Image(systemName: "terminal").frame(width: 24).accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(agent.label).font(.body.weight(.medium))
                            if !agent.installed {
                                Text(L("settings.agents.missing")).font(.caption).foregroundStyle(.secondary)
                            } else if !agent.hint.isEmpty {
                                Text(agent.hint).font(.caption).foregroundStyle(.orange)
                            } else if !agent.version.isEmpty {
                                Text(agent.version).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        Toggle(L("settings.connectors.on"), isOn: Binding(get: { agent.enabled }, set: { model.setAgentEnabled(agent.id, $0) }))
                            .labelsHidden()
                            .disabled(!agent.installed)
                            .accessibilityLabel(agent.label)
                    }
                }
                ForEach(model.agentSessions.prefix(5)) { session in
                    HStack(alignment: .top, spacing: Space.m) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(session.label): \(session.task)").font(.callout).lineLimit(1)
                            Text(session.text).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        }
                        Spacer()
                        if session.isActive {
                            Button(L("settings.agents.stop")) { model.stopAgent(session.id) }
                        }
                    }
                }
                Text(L("settings.agents.help")).font(.caption).foregroundStyle(.secondary)
            }
            Section(L("settings.connectors.mcp")) {
                ForEach(model.mcpServers) { server in
                    HStack {
                        Image(systemName: "puzzlepiece.extension").accessibilityHidden(true)
                        Text(server.name)
                        Spacer()
                        Text(L.count("settings.connectors.mcp_tools", server.tools)).foregroundStyle(.secondary)
                        Circle().fill(server.state == "connected" ? Color.green : Color.orange).frame(width: 8, height: 8)
                            .accessibilityLabel(server.state)
                    }
                }
                Text(L("settings.connectors.mcp_help")).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                Button(L("panel.retry")) {
                    model.core.request("mcp.reload") { _ in model.refreshConnectors() }
                }
            }
        }
        .formStyle(.grouped)
        .onAppear { model.refreshAgents() }
    }

    private func folderButton(_ id: String, key: String) -> some View {
        Button(L("settings.stt.choose")) {
            let panel = NSOpenPanel()
            panel.canChooseFiles = false
            panel.canChooseDirectories = true
            panel.allowsMultipleSelection = key == "roots"
            if panel.runModal() == .OK {
                let paths = panel.urls.map(\.path)
                let value: Any = key == "roots" ? paths : (paths.first ?? "")
                model.configureConnector(id, [key: value])
            }
        }
        .buttonStyle(.link)
    }
}

struct PrivacySettings: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var strings: Strings
    @State private var askDeleteTranscripts = false
    @State private var askDeleteAll = false

    var body: some View {
        Form {
            Toggle(L("settings.save_transcripts"), isOn: Binding(
                get: { model.settings["history.saveTranscripts"] as? Bool ?? false },
                set: { on in
                    model.setSetting("history.saveTranscripts", on) { reply in
                        if reply["offerDelete"] as? Bool == true { askDeleteTranscripts = true }
                    }
                }
            ))
            Text(L("settings.save_transcripts.help")).font(.caption).foregroundStyle(.secondary)
            Toggle(L("settings.diagnostics"), isOn: flag(model, "diagnostics.enabled"))
            Text(L("settings.diagnostics.help")).font(.caption).foregroundStyle(.secondary)
            Section {
                Button(L("settings.delete_all"), role: .destructive) { askDeleteAll = true }
            }
        }
        .formStyle(.grouped)
        .alert(L("settings.delete_transcripts"), isPresented: $askDeleteTranscripts) {
            Button(L("settings.delete_transcripts.confirm"), role: .destructive) { model.core.request("history.clearTranscripts") }
            Button(L("settings.keep"), role: .cancel) {}
        }
        .alert(L("settings.delete_all.confirm"), isPresented: $askDeleteAll) {
            Button(L("settings.delete_all.button"), role: .destructive) { model.deleteAllData() }
            Button(L("approval.cancel"), role: .cancel) {}
        }
    }
}

/// Sign in with a ChatGPT account: Murmur shows a code, the user enters it on OpenAI's page.
/// Composio: the key, then every app you can connect, with a switch and a read-only option for each.
struct AppsSettings: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var strings: Strings
    @State private var key = ""
    @State private var query = ""
    @FocusState private var keyFocused: Bool

    var body: some View {
        Form {
            Section {
                Text(L("settings.apps.intro")).font(.callout).foregroundStyle(.secondary)
                if model.composio.hasKey {
                    HStack {
                        Label(L("settings.apps.key_saved"), systemImage: "key.fill")
                        Spacer()
                        Button(L("settings.apps.remove_key")) { model.removeComposioKey() }
                    }
                } else {
                    HStack {
                        SecureField(L("settings.apps.key"), text: $key)
                            .focused($keyFocused)
                            .onSubmit(commitKey)
                        Button(L("approval.save"), action: commitKey)
                    }
                    Text(L("settings.apps.key_help")).font(.caption).foregroundStyle(.secondary)
                }
                if let error = model.composio.error {
                    Text(L("settings.apps.failed", ["error": error])).font(.caption).foregroundStyle(.red)
                }
            }
            if model.composio.hasKey {
                Section {
                    TextField(L("settings.apps.search"), text: $query)
                        .onSubmit { model.refreshComposioApps(query: query) }
                    if model.composio.apps.isEmpty && !model.composio.loading {
                        Text(L("settings.apps.empty")).foregroundStyle(.secondary)
                    }
                    ForEach(model.composio.apps.prefix(60)) { app in appRow(app) }
                    if model.composio.loading { ProgressView().controlSize(.small) }
                }
                Section { Text(L("settings.apps.privacy")).font(.caption).foregroundStyle(.secondary) }
            }
        }
        .formStyle(.grouped)
        .onAppear { model.refreshComposio() }
        .onChange(of: keyFocused) { focused in
            if !focused { commitKey() }
        }
        .onDisappear(perform: commitKey)
    }

    private func appRow(_ app: ComposioApp) -> some View {
        HStack(alignment: .top, spacing: Space.m) {
            Image(systemName: app.connected ? "checkmark.circle.fill" : "circle.dashed")
                .foregroundStyle(app.connected ? Color.green : Color.secondary)
                .frame(width: 24)
                .accessibilityLabel(app.connected ? L("settings.apps.connected") : "")
            VStack(alignment: .leading, spacing: 2) {
                Text(app.name).font(.body.weight(.medium))
                if !app.description.isEmpty {
                    Text(app.description).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
                if app.connected {
                    Toggle(L("settings.apps.read_only"), isOn: Binding(
                        get: { app.readOnly },
                        set: { model.configureComposioApp(app.slug, readOnly: $0) }
                    ))
                    .font(.caption)
                    .toggleStyle(.checkbox)
                }
                if model.composio.connecting == app.slug {
                    Text(L("settings.apps.waiting")).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if app.connected {
                Toggle(L("settings.apps.use"), isOn: Binding(
                    get: { app.enabled },
                    set: { model.configureComposioApp(app.slug, enabled: $0) }
                ))
                .labelsHidden()
                .accessibilityLabel("\(app.name): \(L("settings.apps.use"))")
                Button(L("settings.apps.disconnect")) { model.disconnectComposioApp(app.slug) }
            } else {
                Button(L("settings.apps.connect")) { model.connectComposioApp(app.slug) }
                    .disabled(model.composio.connecting != nil)
            }
        }
    }

    private func commitKey() {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        model.saveComposioKey(trimmed)
        key = ""
    }
}

struct ChatGptSection: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var strings: Strings

    var body: some View {
        Group {
            Text(L("settings.llm.chatgpt.help")).font(.caption).foregroundStyle(.secondary)
            if model.chatgpt.waiting, let code = model.chatgpt.code {
                VStack(alignment: .leading, spacing: Space.s) {
                    Text(L("settings.llm.chatgpt.code")).font(.callout)
                    Text(code)
                        .font(.system(.title, design: .monospaced).weight(.semibold))
                        .textSelection(.enabled)
                        .accessibilityLabel(code.map { String($0) }.joined(separator: " "))
                    HStack {
                        Button(L("settings.llm.chatgpt.copy")) {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(code, forType: .string)
                        }
                        Button(L("settings.llm.chatgpt.open")) { model.openChatGptPage() }
                        Button(L("settings.llm.chatgpt.cancel")) { model.cancelChatGptLogin() }
                    }
                    Text(L("settings.llm.chatgpt.waiting")).font(.caption).foregroundStyle(.secondary)
                }
            } else if model.chatgpt.signedIn {
                HStack {
                    Label(
                        model.chatgpt.email.map { L("settings.llm.chatgpt.signed_in_as", ["email": $0]) } ?? L("settings.llm.chatgpt.signed_in"),
                        systemImage: "checkmark.seal.fill"
                    )
                    Spacer()
                    Button(L("settings.llm.chatgpt.sign_out")) { model.signOutChatGpt() }
                }
            } else {
                Button(L("settings.llm.chatgpt.sign_in")) { model.startChatGptLogin() }
                    .disabled(model.chatgpt.waiting)
            }
            if let error = model.chatgpt.error {
                Text(L("settings.llm.chatgpt.failed", ["error": error])).font(.caption).foregroundStyle(.red)
            }
        }
        .onAppear { model.refreshChatGpt() }
    }
}
