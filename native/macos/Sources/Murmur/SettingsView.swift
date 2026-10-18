import AppKit
import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var strings: Strings

    var body: some View {
        TabView {
            GeneralSettings().tabItem { Label(L("settings.tab.general"), systemImage: "gearshape") }
            DictationSettings().tabItem { Label(L("settings.tab.dictation"), systemImage: "waveform") }
            AgentSettings().tabItem { Label(L("settings.tab.agent"), systemImage: "sparkles") }
            ConnectorSettings().tabItem { Label(L("settings.tab.connectors"), systemImage: "puzzlepiece.extension") }
            PrivacySettings().tabItem { Label(L("settings.tab.privacy"), systemImage: "hand.raised") }
        }
        .padding(Space.l)
        .frame(width: 620, height: 480)
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
            Section {
                LabeledContent(L("settings.hotkey.dictate"), value: model.hotkeyName)
                LabeledContent(L("settings.hotkey.agent"), value: "\(model.hotkeyName) + Shift")
                LabeledContent(L("settings.hotkey.edit"), value: "\(model.hotkeyName) + Command")
            }
        }
        .formStyle(.grouped)
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
            Section {
                pathRow(L("settings.stt.binary"), key: "stt.binary", directories: false)
                pathRow(L("settings.stt.model"), key: "stt.model", directories: false)
            }
        }
        .formStyle(.grouped)
    }

    private func pathRow(_ label: String, key: String, directories: Bool) -> some View {
        HStack {
            TextField(label, text: text(model, key))
            Button(L("settings.stt.choose")) {
                let panel = NSOpenPanel()
                panel.canChooseFiles = !directories
                panel.canChooseDirectories = directories
                if panel.runModal() == .OK, let url = panel.url { model.setSetting(key, url.path) }
            }
        }
    }
}

struct AgentSettings: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var strings: Strings
    @State private var apiKey = ""

    private var provider: String { model.settings["llm.provider"] as? String ?? "none" }

    var body: some View {
        Form {
            Picker(L("settings.llm.provider"), selection: Binding(get: { provider }, set: { model.setSetting("llm.provider", $0) })) {
                Text(L("settings.llm.none")).tag("none")
                Text(L("settings.llm.anthropic")).tag("anthropic")
                Text(L("settings.llm.openai")).tag("openai-compatible")
            }
            if provider != "none" {
                TextField(L("settings.llm.model"), text: text(model, "llm.model"))
                if provider == "openai-compatible" {
                    TextField(L("settings.llm.base_url"), text: text(model, "llm.baseUrl"))
                }
                HStack {
                    SecureField(L("settings.llm.api_key"), text: $apiKey)
                    Button(L("approval.save")) {
                        model.saveApiKey(apiKey)
                        apiKey = ""
                    }
                }
                if Keychain.get("llm/apiKey") != nil {
                    Label(L("settings.llm.key_saved"), systemImage: "key.fill").font(.caption).foregroundStyle(.secondary)
                }
            }
            if !model.llmReady {
                Text(L("settings.llm.missing")).font(.callout).foregroundStyle(.orange)
            }
        }
        .formStyle(.grouped)
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
