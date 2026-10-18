import AppKit
import ServiceManagement
import SwiftUI
import UserNotifications

enum ShellState: String {
    case starting, idle, listening, transcribing, cleaning, inserting, done, error, agent

    var menuKey: String { "menu.state.\(rawValue)" }
}

/// Owns the core connection, the hotkey, the microphone and every window. Runs on the main thread.
final class AppModel: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = AppModel()

    // The notch picks its surface from these four, synchronously, so listening shows in the same frame as the key press.
    @Published var state: ShellState = .starting { didSet { windows.updateNotch() } }
    @Published var level: Float = 0
    @Published var action: HotkeyAction = .dictate
    @Published var report: [ReportItem] = []
    @Published var reportMessage: String?
    @Published var reportVisible = false { didSet { windows.updateNotch() } }
    @Published var undoEntryId: Int?
    @Published var approvals: [Preview] = [] { didSet { windows.updateNotch() } }
    @Published var tasks: [String: TaskInfo] = [:] { didSet { windows.updateNotch() } }
    @Published var history: [TaskInfo] = []
    @Published var recent: [String] = []
    @Published var settings: JSONObject = [:]
    @Published var connectors: [ConnectorInfo] = []
    @Published var mcpServers: [McpServerInfo] = []
    @Published var llmReady = false
    @Published var sttReady = false
    @Published var panelVisible = false
    @Published var notice: String?
    @Published var apiKeySaved = Keychain.exists("llm/apiKey")
    @Published var apiKeyError: String?
    @Published var micStatus = Permissions.microphone
    @Published var axStatus = Permissions.accessibility
    @Published var screenStatus = Permissions.screenRecording

    let core = CoreClient()
    let hotkey = HotkeyMonitor()
    let audio = AudioCapture()
    let updater = Updater()
    lazy var windows = WindowManager(model: self)

    private var pressStarted = Date()
    private var reportTimer: Timer?
    private var restartDelay: TimeInterval = 1
    private var permissionTimer: Timer?

    var hotkeyName: String { HotkeyMonitor.name(for: hotkey.keyCode) }
    var soundOn: Bool { settings["sound.enabled"] as? Bool ?? true }
    var activeTasks: [TaskInfo] { tasks.values.filter(\.isActive).sorted { $0.startedAt > $1.startedAt } }

    // MARK: Startup

    func start() {
        registerCoreHandlers()
        startCore()
        audio.onLevel = { [weak self] value in self?.level = value }
        hotkey.onDown = { [weak self] action in self?.hotkeyDown(action) }
        hotkey.onUp = { [weak self] in self?.hotkeyUp() }
        updater.onFound = { [weak self] version in
            self?.postNotification(title: L("update.available", ["version": version]), body: L("update.notify_body"))
        }
        updater.startAutomaticChecks()
        hotkey.onActionChange = { [weak self] action in
            guard let self, self.state == .listening else { return }
            self.action = action
        }
        hotkey.onEscape = { [weak self] in self?.cancelListening() }
        hotkey.onFocusShortcut = { [weak self] in self?.windows.notch.focusApproval() }
        // Creating the event tap without permission files a TCC request on every launch, so check first.
        if Permissions.accessibility == .granted {
            if !hotkey.start() { state = .idle }
        } else {
            startPermissionPolling()
        }
        if Bundle.main.bundleIdentifier != nil {
            let center = UNUserNotificationCenter.current()
            center.delegate = self
            let snooze = UNNotificationAction(identifier: "snooze", title: L("notify.reminder.snooze"), options: [])
            let done = UNNotificationAction(identifier: "done", title: L("notify.reminder.done"), options: [])
            center.setNotificationCategories([UNNotificationCategory(identifier: "reminder", actions: [snooze, done], intentIdentifiers: [], options: [])])
            center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
        }
        if !UserDefaults.standard.bool(forKey: "onboarded") || Permissions.microphone != .granted {
            windows.showOnboarding()
        }
    }

    private func startCore() {
        state = .starting
        core.onNotification = { [weak self] method, params in self?.coreNotification(method, params) }
        core.onExit = { [weak self] _ in
            guard let self else { return }
            self.notice = L("error.core_stopped")
            self.state = .error
            DispatchQueue.main.asyncAfter(deadline: .now() + self.restartDelay) { self.startCore() }
            self.restartDelay = min(self.restartDelay * 2, 60)
        }
        do {
            try core.start()
        } catch {
            notice = error.localizedDescription
            state = .error
        }
    }

    private func registerCoreHandlers() {
        core.handle("text.insert") { params, reply in
            let result = TextInserter.insert(params["text"] as? String ?? "")
            reply(.success(["ok": result.ok, "method": result.method.rawValue] as JSONObject))
        }
        core.handle("context.capture") { _, reply in reply(.success(ContextCapture.capture())) }
        core.handle("secret.get") { params, reply in
            if let value = Keychain.get(params["key"] as? String ?? "") {
                reply(.success(["value": value]))
            } else {
                reply(.success(["value": NSNull()]))
            }
        }
        core.handle("secret.set") { params, reply in
            switch Keychain.save(params["key"] as? String ?? "", params["value"] as? String ?? "") {
            case .success: reply(.success(["ok": true]))
            case let .failure(error):
                reply(.failure(CoreError.remote(code: -1, message: "Keychain write failed: \(error.localizedDescription)")))
            }
        }
        core.handle("secret.delete") { params, reply in
            Keychain.delete(params["key"] as? String ?? "")
            reply(.success(["ok": true]))
        }
        core.handle("url.open") { params, reply in
            if let string = params["url"] as? String, let url = URL(string: string), url.scheme == "https" {
                NSWorkspace.shared.open(url)
                reply(.success(["ok": true]))
            } else {
                reply(.failure(CoreError.remote(code: -1, message: "Only https links can be opened")))
            }
        }
    }

    private func coreReady() {
        restartDelay = 1
        notice = nil
        let locale = (UserDefaults.standard.string(forKey: "locale")) ?? "system"
        core.request("i18n.strings", ["locale": locale]) { result in
            if case let .success(value) = result, let object = value as? JSONObject,
               let strings = object["strings"] as? [String: String] {
                L.load(strings, locale: object["locale"] as? String ?? "en")
            }
        }
        core.request("core.hello", ["shell": "macos"]) { [weak self] result in
            guard let self, case let .success(value) = result, let info = value as? JSONObject else { return }
            self.llmReady = info["llm"] as? Bool ?? false
            self.sttReady = info["stt"] as? Bool ?? false
            self.state = .idle
        }
        refreshSettings()
        refreshRecent()
        refreshConnectors()
    }

    // MARK: Hotkey

    private func hotkeyDown(_ action: HotkeyAction) {
        // A press during the release tail of the previous recording is ignored.
        guard state != .starting, !audio.isRecording else { return }
        self.action = action
        pressStarted = Date()
        // Setting the state shows the listening surface right away.
        state = .listening
        reportTimer?.invalidate()
        reportVisible = false
        Cue.play(start: true, enabled: soundOn)
        do {
            try audio.start()
        } catch {
            notice = L("error.no_mic")
            showError(L("error.no_mic"))
            return
        }
        core.request("dictation.start")
    }

    private func hotkeyUp() {
        guard state == .listening else { return }
        Cue.play(start: false, enabled: soundOn)
        if Date().timeIntervalSince(pressStarted) < 0.3 {
            cancelListening()
            return
        }
        state = .transcribing
        // Keep recording for a moment after release so the last word isn't clipped.
        audio.stop(afterTail: { [weak self] pcm in self?.send(pcm) })
    }

    private func send(_ pcm: Data) {
        guard state == .transcribing else { return }
        let audioParams: JSONObject = ["audio": pcm.base64EncodedString(), "sampleRate": 16_000]
        switch action {
        case .dictate:
            core.request("dictation.stop", audioParams, timeout: 60) { [weak self] result in
                if case let .failure(error) = result { self?.showError(error.localizedDescription) }
            }
        case .edit:
            core.request("edit.run", audioParams, timeout: 60) { [weak self] result in
                switch result {
                case .success: self?.finishQuietly()
                case let .failure(error): self?.showError(error.localizedDescription)
                }
            }
        case .agent:
            state = .agent
            core.request("agent.run", audioParams, timeout: 60) { [weak self] result in
                if case let .failure(error) = result { self?.showError(error.localizedDescription) }
            }
        }
    }

    func cancelListening() {
        _ = audio.stop()
        core.request("dictation.cancel")
        state = .idle
    }

    func retryDictation() {
        reportVisible = false
        state = .transcribing
        core.request("dictation.retry") { [weak self] result in
            if case let .failure(error) = result { self?.showError(error.localizedDescription) }
        }
    }

    private func finishQuietly() {
        state = .idle
    }

    private func showError(_ message: String) {
        state = .error
        report = []
        reportMessage = message
        showReport(seconds: 8)
    }

    /// The change report stays for 6 seconds, then the notch moves on (a waiting approval returns).
    func showReport(seconds: TimeInterval = 6) {
        reportVisible = true
        reportTimer?.invalidate()
        reportTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
            self?.endReport()
        }
    }

    func dismissReport() {
        reportTimer?.invalidate()
        endReport()
    }

    /// Hovering the report keeps it open; leaving it starts a short timer.
    func holdReport(_ hold: Bool) {
        guard reportVisible else { return }
        if hold {
            reportTimer?.invalidate()
        } else {
            showReport(seconds: 3)
        }
    }

    private func endReport() {
        reportTimer = nil
        guard reportVisible else { return }
        if state != .listening {
            state = activeTasks.isEmpty ? .idle : .agent
        }
        reportVisible = false
    }

    /// Undo for a word the dictionary just learned.
    func undoLearnedWord() {
        guard let id = undoEntryId else { return }
        core.request("dictionary.remove", ["id": id])
        undoEntryId = nil
    }

    // MARK: Core notifications

    private func coreNotification(_ method: String, _ params: JSONObject) {
        switch method {
        case "core.ready":
            coreReady()
        case "state":
            guard let raw = params["state"] as? String, let next = ShellState(rawValue: raw) else { return }
            if next == .listening { return }
            if action == .agent, next == .done { return }
            state = next
            if next == .done, let message = params["message"] as? String {
                report = []
                reportMessage = message
                showReport(seconds: 3)
            } else if next == .error {
                reportMessage = params["message"] as? String
                report = []
                showReport(seconds: 8)
            }
        case "dictation.result":
            report = (params["summary"] as? [JSONObject] ?? []).map {
                ReportItem(category: $0["category"] as? String ?? "", count: $0["count"] as? Int ?? 0, label: $0["label"] as? String ?? "")
            }
            reportMessage = nil
            if (params["text"] as? String ?? "").isEmpty == false { refreshRecent() }
            if report.isEmpty { finishQuietly() } else { showReport() }
        case "task.update":
            let info = TaskInfo(update: params)
            let previous = tasks[info.id]
            var merged = info
            merged.startedAt = previous?.startedAt ?? Date()
            tasks[info.id] = merged
            if info.long, !(previous?.long ?? false) {
                showPanel()
            }
            if !info.isActive {
                if !info.long {
                    report = []
                    reportMessage = info.reply
                    state = .done
                    showReport(seconds: max(6, Double(info.reply.count) / 20))
                } else if activeTasks.isEmpty {
                    state = .idle
                }
                refreshHistory()
            }
        case "approval.request":
            guard let json = params["preview"] as? JSONObject, let preview = Preview(json) else { return }
            if let index = approvals.firstIndex(where: { $0.callId == preview.callId }) {
                approvals[index] = preview
            } else {
                approvals.append(preview)
            }
        case "approval.dismiss":
            approvals.removeAll { $0.callId == params["callId"] as? String }
        case "notify":
            postNotification(title: params["title"] as? String ?? "Murmur", body: params["body"] as? String ?? "")
        case "reminder.fire":
            postNotification(title: L("notify.reminder"), body: params["text"] as? String ?? "", reminderId: params["id"] as? Int)
        default:
            break
        }
    }

    // MARK: Approval

    func respond(_ preview: Preview, decision: String, input: JSONObject? = nil) {
        var params: JSONObject = ["callId": preview.callId, "decision": decision]
        if let input { params["input"] = input }
        core.request("approval.respond", params)
    }

    // MARK: Side panel and history

    func showPanel() {
        refreshHistory()
        windows.showPanel()
        panelVisible = true
    }

    func hidePanel() {
        panelVisible = false
        windows.schedulePanelHide()
    }

    func refreshHistory(query: String = "") {
        core.request("task.list", ["query": query, "limit": 50]) { [weak self] result in
            guard case let .success(value) = result, let tasks = (value as? JSONObject)?["tasks"] as? [JSONObject] else { return }
            self?.history = tasks.map(TaskInfo.init(update:))
        }
    }

    func cancelTask(_ id: String) { core.request("task.cancel", ["taskId": id]) }

    func runAgain(_ id: String) {
        core.request("task.runAgain", ["taskId": id]) { [weak self] result in
            if case let .failure(error) = result { self?.notice = error.localizedDescription }
        }
    }

    func refreshRecent() {
        core.request("history.list", ["limit": 5]) { [weak self] result in
            guard case let .success(value) = result, let items = (value as? JSONObject)?["items"] as? [JSONObject] else { return }
            self?.recent = items.map { item in
                if let text = item["transcript"] as? String, !text.isEmpty { return String(text.prefix(60)) }
                return L.count("menu.recent.words", item["wordCount"] as? Int ?? 0)
            }
        }
    }

    // MARK: Settings

    func refreshSettings() {
        core.request("settings.get") { [weak self] result in
            guard case let .success(value) = result, let values = (value as? JSONObject)?["values"] as? JSONObject else { return }
            self?.settings = values
            self?.hotkey.toggleMode = values["dictation.toggleMode"] as? Bool ?? false
        }
    }

    func setSetting(
        _ key: String, _ value: Any, then: ((JSONObject) -> Void)? = nil, failed: ((String) -> Void)? = nil
    ) {
        settings[key] = value
        if key == "dictation.toggleMode" { hotkey.toggleMode = value as? Bool ?? false }
        core.request("settings.set", ["key": key, "value": value]) { [weak self] result in
            switch result {
            case let .success(reply):
                if let object = reply as? JSONObject { then?(object) }
            case let .failure(error):
                NSLog("Murmur: saving setting %@ failed: %@", key, error.localizedDescription)
                failed?(error.localizedDescription)
            }
            self?.core.request("status") { status in
                if case let .success(info) = status, let info = info as? JSONObject {
                    self?.llmReady = info["llm"] as? Bool ?? false
                    self?.sttReady = info["stt"] as? Bool ?? false
                }
            }
        }
    }

    func setLocale(_ locale: String) {
        UserDefaults.standard.set(locale, forKey: "locale")
        setSetting("ui.locale", locale)
        core.request("i18n.strings", ["locale": locale]) { result in
            if case let .success(value) = result, let object = value as? JSONObject,
               let strings = object["strings"] as? [String: String] {
                L.load(strings, locale: object["locale"] as? String ?? "en")
            }
        }
    }

    func refreshConnectors() {
        core.request("connectors.list") { [weak self] result in
            guard case let .success(value) = result, let object = value as? JSONObject else { return }
            self?.connectors = (object["connectors"] as? [JSONObject] ?? []).map {
                ConnectorInfo(
                    id: $0["id"] as? String ?? "",
                    name: $0["name"] as? String ?? "",
                    description: $0["description"] as? String ?? "",
                    icon: $0["icon"] as? String ?? "",
                    skeleton: ($0["status"] as? String) == "skeleton",
                    enabled: $0["enabled"] as? Bool ?? false,
                    auth: $0["auth"] as? String ?? "none"
                )
            }
            self?.mcpServers = (object["mcp"] as? [JSONObject] ?? []).map {
                McpServerInfo(name: $0["name"] as? String ?? "", state: $0["state"] as? String ?? "", tools: $0["tools"] as? Int ?? 0)
            }
        }
    }

    func setConnector(_ id: String, enabled: Bool) {
        if let index = connectors.firstIndex(where: { $0.id == id }) { connectors[index].enabled = enabled }
        core.request(enabled ? "connectors.enable" : "connectors.disable", ["id": id])
    }

    func configureConnector(_ id: String, _ values: JSONObject) {
        core.request("connectors.configure", ["id": id, "settings": values])
    }

    func connect(_ id: String) {
        core.request("connectors.authorize", ["id": id], timeout: 330) { [weak self] result in
            if case let .failure(error) = result { self?.notice = error.localizedDescription }
            self?.refreshConnectors()
        }
    }

    func saveApiKey(_ key: String) {
        apiKeyError = nil
        if key.isEmpty {
            Keychain.delete("llm/apiKey")
        } else if case let .failure(error) = Keychain.save("llm/apiKey", key) {
            apiKeyError = L("settings.llm.key_failed", ["error": error.localizedDescription])
        }
        apiKeySaved = Keychain.exists("llm/apiKey")
        setSetting("llm.provider", settings["llm.provider"] ?? "anthropic")
    }

    /// Saves a file path setting and reads it back from the core, so a lost write shows up in the UI.
    func savePath(_ key: String, _ path: String, failed: @escaping (String) -> Void) {
        setSetting(key, path, then: { [weak self] _ in
            self?.core.request("settings.get", ["key": key]) { result in
                guard case let .success(value) = result else { return }
                if (value as? JSONObject)?["value"] as? String != path {
                    failed(L("settings.save_lost"))
                }
            }
        }, failed: { message in failed(L("settings.save_failed", ["error": message])) })
    }

    func setLaunchAtLogin(_ on: Bool) {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            notice = error.localizedDescription
        }
    }

    var launchAtLogin: Bool { SMAppService.mainApp.status == .enabled }

    func deleteAllData() {
        core.request("data.deleteAll", [:], timeout: 30) { [weak self] _ in
            UserDefaults.standard.removeObject(forKey: "onboarded")
            self?.refreshSettings()
            self?.refreshRecent()
            self?.refreshConnectors()
            self?.history = []
        }
    }

    // MARK: Permissions

    func startPermissionPolling() {
        permissionTimer?.invalidate()
        permissionTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.micStatus = Permissions.microphone
            self.axStatus = Permissions.accessibility
            self.screenStatus = Permissions.screenRecording
            if self.axStatus == .granted, !self.hotkey.isRunning, self.hotkey.start(), !self.windows.onboardingVisible {
                self.stopPermissionPolling()
            }
        }
    }

    /// Stops polling, unless the hotkey is still waiting for permission. Polling only reads status and never prompts.
    func stopPermissionPolling() {
        guard hotkey.isRunning else { return }
        permissionTimer?.invalidate()
        permissionTimer = nil
    }

    // MARK: Notifications

    private func postNotification(title: String, body: String, reminderId: Int? = nil) {
        guard Bundle.main.bundleIdentifier != nil else {
            NSLog("Murmur: %@ — %@", title, body)
            return
        }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        if let reminderId {
            content.categoryIdentifier = "reminder"
            content.userInfo = ["reminderId": reminderId]
        }
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        if let id = response.notification.request.content.userInfo["reminderId"] as? Int {
            DispatchQueue.main.async {
                switch response.actionIdentifier {
                case "snooze": self.core.request("reminders.snooze", ["id": id])
                case "done": self.core.request("reminders.done", ["id": id])
                default: break
                }
            }
        } else {
            DispatchQueue.main.async { self.showPanel() }
        }
        completionHandler()
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
}
