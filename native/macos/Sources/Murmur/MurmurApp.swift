import AppKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        AppModel.shared.start()
    }

    func applicationWillTerminate(_ notification: Notification) {
        AppModel.shared.core.stop()
    }
}

@main
struct MurmurApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @ObservedObject private var model = AppModel.shared
    @ObservedObject private var strings = Strings.shared

    var body: some Scene {
        MenuBarExtra {
            MenuContent().environmentObject(model).environmentObject(strings)
        } label: {
            Image(systemName: menuSymbol)
                .accessibilityLabel("\(L("app.name")): \(L(model.state.menuKey))")
        }
    }

    private var menuSymbol: String {
        switch model.state {
        case .listening: return "waveform.circle.fill"
        case .transcribing, .cleaning, .inserting, .agent: return "ellipsis.circle"
        case .error: return "exclamationmark.triangle"
        default: return "waveform"
        }
    }
}

/// Always shows the current state, the hotkeys, recent history, Settings and Quit.
struct MenuContent: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var strings: Strings

    var body: some View {
        Text(L(model.state.menuKey))
        if let notice = model.notice { Text(notice) }
        Divider()
        Text(L("menu.hotkey.dictate", ["key": model.hotkeyName]))
        Text(L("menu.hotkey.agent", ["key": "\(model.hotkeyName) + Shift"]))
        Text(L("menu.hotkey.edit", ["key": "\(model.hotkeyName) + Command"]))
        Divider()
        Menu(L("menu.recent")) {
            if model.recent.isEmpty {
                Text(L("menu.recent.empty"))
            } else {
                ForEach(Array(model.recent.enumerated()), id: \.offset) { _, item in Text(item) }
            }
        }
        Button(L("menu.type")) { model.openTyping(.ask) }
            .keyboardShortcut("t", modifiers: [.control, .option])
        Button(L("menu.new_chat")) { model.newChat() }
        Button(L("menu.tasks")) { model.showPanel() }
            .keyboardShortcut("t")
        Button(L("menu.settings")) { model.windows.showSettings() }
            .keyboardShortcut(",")
        if model.micStatus != .granted || model.axStatus != .granted {
            Button(L("menu.finish_setup")) { model.windows.showOnboarding() }
        }
        Divider()
        UpdateMenuItems(updater: model.updater)
        Button(L("menu.quit")) { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }
}
