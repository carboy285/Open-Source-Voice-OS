import AppKit
import ServiceManagement
import SwiftUI
import UserNotifications

enum ShellState: String {
    case starting, idle, listening, transcribing, cleaning, inserting, done, error, agent

    var menuKey: String { "menu.state.\(rawValue)" }
}

/// What the typing box sends to: the agent, or an edit of the selected text.
enum TypingMode: Equatable {
    case ask, edit
}

/// The area you circled: a small picture, the words read in it, and what you were working in.
struct CircleCapture {
    var loading = true
    var thumbnail: NSImage?
    var mediaType = "image/png"
    var imageBase64: String?
    var text = ""
    var context: JSONObject = [:]
}

/// The ChatGPT sign-in as the Settings screen shows it.
struct ChatGptState {
    var signedIn = false
    var email: String?
    var code: String?
    var url: String?
    var waiting = false
    var error: String?
}

/// One app Composio can connect, as the Apps tab shows it.
struct ComposioApp: Identifiable {
    var id: String { slug }
    let slug: String
    let name: String
    let description: String
    var connected: Bool
    var enabled: Bool
    var readOnly: Bool
}

/// The Composio link as the Apps tab shows it.
struct ComposioState {
    var hasKey = false
    var apps: [ComposioApp] = []
    var loading = false
    var connecting: String?
    var error: String?
    var keySaved = false
}

/// Owns the core connection, the hotkey, the microphone and every window. Runs on the main thread.
final class AppModel: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = AppModel()

    // The notch picks its surface from these four, synchronously, so listening shows in the same frame as the key press.
    @Published var state: ShellState = .starting {
        didSet {
            windows.updateNotch()
            // A lock belongs to one dictation. When that ends or is cancelled, the next press starts a new one.
            if state != .listening, action != .circle, hotkey.isLocked { hotkey.releaseLock() }
        }
    }
    /// Dictation was locked on with two quick taps of the key and keeps listening until the key is pressed again.
    @Published var dictationLocked = false
    @Published var liveTranscript = ""
    @Published var setupRecording = false
    @Published var setupTranscript = ""
    @Published var setupError: String?
    @Published var setupBusy = false
    @Published var setupInserted = false
    private var setupLimit: Timer?
    private var previewTimer: Timer?
    private var previewBusy = false
    private var recordingGeneration = UUID()
    /// The conversation shown under the typing box: the core's record of this chat, oldest first.
    @Published var chat: [ChatEntry] = []
    /// The request being worked on now, shown right away with "thinking" under it.
    @Published var chatPending: String?
    /// Whether the typing box is opened down into a conversation. Remembered between uses.
    @Published var chatExpanded = UserDefaults.standard.bool(forKey: "chatExpanded") {
        didSet {
            UserDefaults.standard.set(chatExpanded, forKey: "chatExpanded")
            windows.updateNotch()
        }
    }
    /// What is typed in the box, kept while an approval card takes the notch for a moment.
    @Published var typingDraft = ""
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
    @Published var recovery: [RecoveryEntry] = []
    @Published var editReview: EditReview?
    private var insertionTarget: InsertionTarget?
    private var queuedRecovery: (entry: RecoveryEntry, retry: Bool)?
    private var replayOnRelease: (entry: RecoveryEntry, retry: Bool)?
    @Published var settings: JSONObject = [:]
    @Published var connectors: [ConnectorInfo] = []
    @Published var mcpServers: [McpServerInfo] = []
    @Published var codingAgents: [CodingAgentInfo] = []
    @Published var agentSessions: [CodingAgentSession] = []
    @Published var llmReady = false
    @Published var sttReady = false
    @Published var panelVisible = false
    @Published var notice: String?
    @Published var apiKeySaved = Keychain.exists("llm/apiKey")
    /// The AI, speech and voice services Settings can offer, from the core.
    @Published var catalog = ProviderCatalog()
    /// Goes up when a key is saved or removed, so the "key saved" labels refresh.
    @Published var keyRevision = 0
    @Published var apiKeyError: String?
    @Published var chatgpt = ChatGptState()
    @Published var composio = ComposioState()
    /// The typing box in the notch (⌃⌥T): the same Ask and Edit as the hotkey, without speaking.
    @Published var typingOpen = false { didSet { windows.updateNotch() } }
    @Published var typingMode: TypingMode = .ask
    @Published var typingSelectionLength = 0
    /// True while a reply is being read aloud.
    @Published var speaking = false
    let speaker = Speaker()
    /// Circle to Ask (hold the key, drag around something): the card that follows.
    @Published var circle: CircleCapture? { didSet { windows.updateNotch() } }
    /// Typed Ask: also send a picture of the window you were in.
    @Published var typingAttachScreen = false
    private let circleOverlay = CircleOverlay()
    private var circleContext: JSONObject = [:]
    private var typingFrontPID: pid_t = 0
    /// The app and selection seen before the box took focus; sent with the request.
    private var typingContext: JSONObject = [:]
    @Published var micStatus = Permissions.microphone
    @Published var axStatus = Permissions.accessibility
    @Published var screenStatus = Permissions.screenRecording

    private let keychainQueue = DispatchQueue(label: "murmur.keychain")
    let core = CoreClient()
    lazy var speech = SpeechModelStore(core: core)
    let hotkey = HotkeyMonitor()
    let audio = AudioCapture()
    let updater = Updater()
    lazy var windows = WindowManager(model: self)

    private var pressStarted = Date()
    /// Cancels a single tap when no second tap follows. Keeping the recording alive through the gap is what makes
    /// double-tap-to-lock continuous instead of a cancel and restart.
    private var tapCancel: DispatchWorkItem?
    private var reportTimer: Timer?
    private var restartDelay: TimeInterval = 1
    private var permissionTimer: Timer?
    private var hotkeyWatch: Timer?
    private var accessibilityWasGranted = false

    var hotkeyName: String { HotkeyMonitor.name(for: hotkey.keyCode) }
    var soundOn: Bool { settings["sound.enabled"] as? Bool ?? true }
    var activeTasks: [TaskInfo] { tasks.values.filter(\.isActive).sorted { $0.startedAt > $1.startedAt } }

    // MARK: Startup

    func start() {
        registerCoreHandlers()
        startCore()
        audio.onLevel = { [weak self] value in self?.level = value }
        hotkey.onDown = { [weak self] action, continued in
            guard let self else { return }
            // A press that could not start listening must not leave a lock behind.
            if self.hotkeyDown(action, continued: continued) == false { self.hotkey.releaseLock() }
        }
        hotkey.onLockChange = { [weak self] locked in self?.dictationLocked = locked }
        hotkey.doubleTapLock = UserDefaults.standard.object(forKey: "doubleTapLock") as? Bool ?? true
        hotkey.onUp = { [weak self] fromLock in self?.hotkeyUp(fromLock: fromLock) }
        updater.onFound = { [weak self] version in
            self?.postNotification(title: L("update.available", ["version": version]), body: L("update.notify_body"))
        }
        if Bundle.main.object(forInfoDictionaryKey: "MurmurLocalBuild") as? Bool != true { updater.startAutomaticChecks() }
        speech.onFinished = { [weak self] info in
            self?.postNotification(title: L("models.ready", ["name": info.name]), body: L("models.ready_body"))
        }
        speech.onChange = { [weak self] in self?.refreshStatus() }
        hotkey.onActionChange = { [weak self] action in
            guard let self else { return }
            // Control added after the key went down: this was not a dictation after all.
            if action == .circle, self.state == .listening {
                self.cancelListening()
                self.action = .circle
                self.beginCircle()
                return
            }
            guard self.state == .listening else { return }
            self.action = action
        }
        speaker.onChange = { [weak self] speaking in self?.speaking = speaking }
        hotkey.onEscape = { [weak self] in
            self?.cancelCurrentRequest()
            self?.cancelCircle()
        }
        hotkey.onTypeShortcut = { [weak self] in self?.toggleTyping() }
        hotkey.onFocusShortcut = { [weak self] in self?.windows.notch.focusApproval() }
        // Creating the event tap without permission files a TCC request on every launch, so check first.
        if Permissions.accessibility == .granted {
            if !hotkey.start() { state = .idle }
        } else {
            startPermissionPolling()
        }
        accessibilityWasGranted = Permissions.accessibility == .granted
        watchHotkey()
        if Bundle.main.bundleIdentifier != nil {
            let center = UNUserNotificationCenter.current()
            center.delegate = self
            let snooze = UNNotificationAction(identifier: "snooze", title: L("notify.reminder.snooze"), options: [])
            let done = UNNotificationAction(identifier: "done", title: L("notify.reminder.done"), options: [])
            center.setNotificationCategories([UNNotificationCategory(identifier: "reminder", actions: [snooze, done], intentIdentifiers: [], options: [])])
            center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
        }
        // Setup opens once, on the very first launch. After an update the app just starts; if macOS
        // forgot a permission (ad-hoc builds lose them), the menu offers "Finish setup" instead.
        if !UserDefaults.standard.bool(forKey: "onboarded") {
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
        core.handle("text.preview") { [weak self] params, reply in
            guard let self else { reply(.success(["approved": false])); return }
            self.editReview = EditReview(before: params["before"] as? String ?? "", after: params["after"] as? String ?? "", reply: reply)
            self.showPanel()
        }
        core.handle("text.insert") { params, reply in
            if params["guardTarget"] as? Bool == true, !self.windows.onboardingIsKey,
               self.insertionTarget?.verdict == .changed {
                reply(.success(["ok": false, "method": "none", "reason": "target_changed"]))
                return
            }
            let result = TextInserter.insert(params["text"] as? String ?? "")
            RecentInsertion.remember(params["text"] as? String ?? "", ok: result.ok)
            if result.ok, self.windows.onboardingIsKey { self.setupInserted = true }
            var payload: JSONObject = ["ok": result.ok, "method": result.method.rawValue]
            if let reason = result.reason { payload["reason"] = reason }
            reply(.success(payload))
        }
        core.handle("text.replaceRecent") { params, reply in
            reply(.success(["ok": RecentInsertion.replace(expected: params["expected"] as? String ?? "", with: params["replacement"] as? String ?? "")]))
        }
        core.handle("text.selectAll") { _, reply in reply(.success(["ok": self.insertionTarget?.verdict != .changed && TextInserter.selectAll()])) }
        core.handle("context.capture") { _, reply in reply(.success(ContextCapture.capture())) }
        core.handle("secret.get") { params, reply in
            let key = params["key"] as? String ?? ""
            self.keychainQueue.async {
                if let value = Keychain.get(key) { reply(.success(["value": value])) }
                else { reply(.success(["value": NSNull()])) }
            }
        }
        core.handle("secret.set") { params, reply in
            let key = params["key"] as? String ?? ""
            let value = params["value"] as? String ?? ""
            self.keychainQueue.async {
                switch Keychain.save(key, value) {
                case .success: reply(.success(["ok": true]))
                case let .failure(error):
                    reply(.failure(CoreError.remote(code: -1, message: "Keychain write failed: \(error.localizedDescription)")))
                }
            }
        }
        core.handle("secret.delete") { params, reply in
            let key = params["key"] as? String ?? ""
            self.keychainQueue.async { Keychain.delete(key); reply(.success(["ok": true])) }
        }
        core.handle("apple.call") { params, reply in
            AppleBridge.call(
                service: params["service"] as? String ?? "",
                action: params["action"] as? String ?? "",
                args: params["args"] as? JSONObject ?? [:],
                reply: reply
            )
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
        speech.refresh()
        refreshProviders()
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

    /// False when the press did not start listening.
    @discardableResult
    private func hotkeyDown(_ action: HotkeyAction, continued: Bool = false) -> Bool {
        guard !setupRecording, !setupBusy else { return false }
        guard ![ShellState.transcribing, .cleaning, .inserting].contains(state), editReview == nil else { return false }
        // The second tap of a double tap arrives while the first tap's recording is still running on purpose.
        // Keep it rather than cancel and restart: a restart loses the first word and can be refused while the
        // microphone is still stopping.
        tapCancel?.cancel()
        tapCancel = nil
        if continued, state == .listening, audio.isRecording {
            insertionTarget = insertionTarget ?? InsertionTarget.capture()
            return true
        }
        if !continued, state == .listening, audio.isRecording {
            // A fresh press after a tap that was not followed by a second one: end that recording before starting.
            cancelListening()
        }
        insertionTarget = InsertionTarget.capture()
        if let queued = queuedRecovery, action == .dictate {
            queuedRecovery = nil
            replayOnRelease = queued
            self.action = queued.entry.mode == "edit" && queued.retry ? .edit : .dictate
            state = .listening
            return true
        }
        // A press during the release tail of the previous recording is ignored.
        guard state != .starting, !audio.isRecording else { return false }
        // Talking over the reply, and the microphone hearing it, are both worse than stopping it.
        speaker.stop()
        closeTyping()
        if action == .circle {
            self.action = action
            beginCircle()
            // An overlay that never appeared (no permission, switched off) must not leave a lock behind.
            return circleOverlay.isShowing
        }
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
            return false
        }
        core.request("dictation.start")
        startLivePreview()
        return true
    }

    private func hotkeyUp(fromLock: Bool = false) {
        tapCancel?.cancel()
        tapCancel = nil
        if let replay = replayOnRelease {
            replayOnRelease = nil
            core.request("dictation.start")
            if replay.retry {
                state = .cleaning
                let method = replay.entry.mode == "edit" ? "edit.run" : "dictation.stop"
                let params: JSONObject = replay.entry.transcript.isEmpty ? [:] : ["transcript": replay.entry.transcript]
                core.request(replay.entry.transcript.isEmpty ? "dictation.retry" : method, params, timeout: 300) { [weak self] result in
                    if case let .failure(error) = result { self?.showError(error.localizedDescription) }
                }
            } else if insertionTarget?.verdict != .changed {
                let result = TextInserter.insert(replay.entry.text)
                RecentInsertion.remember(replay.entry.text, ok: result.ok)
                if result.ok { state = .idle } else { showError(L("report.copied")) }
            } else { showError(L("report.destination_changed")) }
            return
        }
        stopLivePreview()
        if action == .circle {
            // Letting go before drawing cancels; letting go mid-drag still finishes when the mouse is released.
            if circleOverlay.isShowing, !circleOverlay.isDragging { circleOverlay.hide() }
            return
        }
        // Whatever moved the state away, an open microphone means the hold is still being recorded.
        if audio.isRecording, state != .listening, state != .transcribing {
            NSLog("Murmur: state was %@ while recording; restoring", state.rawValue)
            state = .listening
        }
        guard state == .listening else { return }
        Cue.play(start: false, enabled: soundOn)
        // A short press may be the first half of a double tap, so keep recording through the gap. A second tap
        // locks the same recording; a single tap is cancelled when the gap closes. Ending a lock always transcribes.
        if !fromLock, Date().timeIntervalSince(pressStarted) < DoubleTapLock.tapLimit {
            guard hotkey.doubleTapLock else {
                cancelListening()
                return
            }
            let work = DispatchWorkItem { [weak self] in
                guard let self, self.state == .listening, !self.hotkey.isLocked else { return }
                self.cancelListening()
            }
            tapCancel = work
            DispatchQueue.main.asyncAfter(deadline: .now() + DoubleTapLock.gap, execute: work)
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
            core.request("edit.run", audioParams, timeout: 300) { [weak self] result in
                switch result {
                case .success: self?.finishQuietly()
                case let .failure(error): self?.showError(error.localizedDescription)
                }
            }
        case .agent:
            state = .agent
            let attach = settings["screen.attach"] as? Bool ?? false
            attachWindowPicture(to: audioParams, pid: NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0, include: attach) { [weak self] params in
                self?.core.request("agent.run", params, timeout: 60) { result in
                    if case let .failure(error) = result { self?.showError(error.localizedDescription) }
                }
            }
        case .circle:
            break
        }
    }

    private func startLivePreview() {
        stopLivePreview()
        guard action == .dictate, settings["dictation.livePreview"] as? Bool ?? true else { return }
        let generation = recordingGeneration
        previewTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            guard let self, self.audio.isRecording, !self.previewBusy else { return }
            self.previewBusy = true
            self.core.request("dictation.preview", ["audio": self.audio.preview().base64EncodedString(), "sampleRate": 16000], timeout: 35) { [weak self] result in
                guard let self else { return }
                self.previewBusy = false
                guard self.recordingGeneration == generation, self.state == .listening else { return }
                if case let .success(value) = result, let object = value as? JSONObject, let text = object["text"] as? String, !text.isEmpty {
                    self.liveTranscript = text
                    self.windows.updateNotch()
                }
            }
        }
    }

    private func stopLivePreview() {
        previewTimer?.invalidate(); previewTimer = nil
        recordingGeneration = UUID()
        liveTranscript = ""
    }

    func toggleSetupPractice() {
        guard !setupBusy else { return }
        setupError = nil
        if setupRecording {
            setupLimit?.invalidate(); setupLimit = nil
            let pcm = audio.stop()
            setupRecording = false
            setupBusy = true
            core.request("setup.practice", ["audio": pcm.base64EncodedString(), "sampleRate": 16000], timeout: 60) { [weak self] result in
                guard let self else { return }
                self.setupBusy = false
                switch result {
                case let .success(value):
                    self.setupTranscript = (value as? JSONObject)?["text"] as? String ?? ""
                    if self.setupTranscript.isEmpty { self.setupError = L("setup.no_speech") }
                case let .failure(error): self.setupError = error.localizedDescription
                }
            }
        } else {
            guard !audio.isRecording else { return }
            do {
                try audio.start(); setupRecording = true; setupTranscript = ""
                setupLimit = Timer.scheduledTimer(withTimeInterval: 20, repeats: false) { [weak self] _ in
                    if self?.setupRecording == true { self?.toggleSetupPractice() }
                }
            }
            catch { setupError = L("error.no_mic") }
        }
    }

    func cancelSetupPractice() {
        setupLimit?.invalidate(); setupLimit = nil
        if setupRecording { _ = audio.stop() }
        setupRecording = false
    }

    // MARK: Typing

    func toggleTyping() {
        if typingOpen { closeTyping() } else { openTyping(.ask) }
    }

    /// Opens the typing box. The app and selection are read first, while the user's app still has focus.
    func openTyping(_ mode: TypingMode) {
        guard state != .listening, !audio.isRecording else { return }
        speaker.stop()
        insertionTarget = InsertionTarget.capture()
        typingContext = ContextCapture.capture()
        typingFrontPID = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
        typingAttachScreen = settings["screen.attach"] as? Bool ?? false
        typingSelectionLength = (typingContext["selection"] as? String)?.count ?? 0
        // Editing the text in another app is not a conversation, so the box closes up for it.
        if mode == .edit { chatExpanded = false }
        typingMode = chatExpanded ? .ask : mode
        reportTimer?.invalidate()
        reportVisible = false
        typingDraft = ""
        typingOpen = true
        if chatExpanded { refreshChat() }
    }

    func closeTyping() {
        typingDraft = ""
        if typingOpen { typingOpen = false }
    }

    // MARK: Chat

    /// Opens the typing box already opened down into the conversation.
    func openChat() {
        chatExpanded = true
        if typingOpen { refreshChat() } else { openTyping(.ask) }
    }

    /// The down arrow: opens the box into a conversation, or folds it back to a single line.
    func toggleChat() {
        chatExpanded.toggle()
        if chatExpanded {
            typingMode = .ask
            refreshChat()
        }
    }

    func refreshChat() {
        core.request("conversation.history") { [weak self] result in
            guard case let .success(value) = result, let json = value as? JSONObject else { return }
            self?.applyChat(json)
        }
    }

    private func applyChat(_ json: JSONObject) {
        chat = (json["entries"] as? [JSONObject] ?? []).compactMap(ChatEntry.init)
        chatPending = (json["pending"] as? JSONObject)?["request"] as? String
    }

    /// Sends what was typed, then returns focus to the user's app (the notch does that when the box closes).
    func submitTyping(_ text: String) {
        let request = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !request.isEmpty else { return }
        let mode = typingMode
        let context = typingContext
        // In the conversation view the box stays open for the next message; otherwise it closes as before.
        let keepOpen = chatExpanded && mode == .ask
        if keepOpen {
            typingDraft = ""
            chatPending = request
        } else {
            closeTyping()
        }
        speaker.stop()
        reportTimer?.invalidate()
        reportVisible = false
        switch mode {
        case .ask:
            action = .agent
            state = .agent
            let params: JSONObject = ["transcript": request, "context": context]
            attachWindowPicture(to: params, pid: typingFrontPID, include: typingAttachScreen) { [weak self] params in
                self?.core.request("agent.run", params, timeout: 60) { result in
                    if case let .failure(error) = result {
                        self?.chatPending = nil
                        self?.showError(error.localizedDescription)
                    }
                }
            }
        case .edit:
            core.request("dictation.start")
            action = .edit
            state = .cleaning
            core.request("edit.run", ["transcript": request, "context": context], timeout: 300) { [weak self] result in
                switch result {
                case .success: self?.finishQuietly()
                case let .failure(error): self?.showError(error.localizedDescription)
                }
            }
        }
    }

    // MARK: Circle to Ask and looking at the screen

    /// Starts Circle to Ask: a sheet over the screen where the pointer is, to draw on.
    func beginCircle() {
        guard settings["circle.enabled"] as? Bool ?? true else { return }
        guard #available(macOS 14.0, *) else {
            showError(L("circle.needs_macos14"))
            return
        }
        guard Permissions.screenRecording == .granted else {
            Permissions.requestScreenRecording()
            showError(L("circle.need_permission"))
            return
        }
        speaker.stop()
        closeTyping()
        circle = nil
        circleContext = ContextCapture.capture()
        guard let screen = NSScreen.screens.first(where: { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) }) ?? NSScreen.main else { return }
        circleOverlay.show(on: screen) { [weak self] region in
            // A locked Circle to Ask is done once the loop is drawn (or was too small).
            self?.hotkey.releaseLock()
            guard let self, let region else {
                self?.circleOverlay.hide()
                return
            }
            self.finishCircle(region, screen: screen)
        }
    }

    func cancelCircle() {
        circleOverlay.hide()
        if circle != nil { circle = nil }
    }

    private func finishCircle(_ region: CGRect, screen: NSScreen) {
        circleOverlay.hide()
        guard #available(macOS 14.0, *), let displayID = ScreenGrabber.displayID(of: screen) else {
            showError(L("circle.capture_failed"))
            return
        }
        circle = CircleCapture(context: circleContext)
        Task { @MainActor in
            // Let the sheet leave the screen before the picture is taken.
            try? await Task.sleep(nanoseconds: 120_000_000)
            do {
                let image = try await ScreenGrabber.capture(region: region, displayID: displayID)
                let text = await TextReader.read(image)
                guard var capture = self.circle else { return }
                let encoded = ImagePrep.encode(image)
                capture.loading = false
                capture.thumbnail = NSImage(cgImage: image, size: NSSize(width: region.width, height: region.height))
                capture.mediaType = encoded?.mediaType ?? "image/png"
                capture.imageBase64 = encoded?.base64
                capture.text = text
                self.circle = capture
            } catch {
                NSLog("Murmur: circle capture failed: %@", error.localizedDescription)
                self.circle = nil
                self.showError(L("circle.capture_failed"))
            }
        }
    }

    /// Sends a question about the circled area: the picture, the words read in it, and the app you were in.
    func submitCircle(_ prompt: String) {
        let request = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let capture = circle, !capture.loading, !request.isEmpty else { return }
        var context = capture.context
        context["picture"] = "circle"
        context["circledText"] = capture.text
        var params: JSONObject = ["transcript": request, "context": context]
        if let data = capture.imageBase64 { params["images"] = [["mediaType": capture.mediaType, "data": data] as JSONObject] }
        circle = nil
        speaker.stop()
        reportTimer?.invalidate()
        reportVisible = false
        action = .agent
        state = .agent
        core.request("agent.run", params, timeout: 60) { [weak self] result in
            if case let .failure(error) = result { self?.showError(error.localizedDescription) }
        }
    }

    /// Copies the words read in the circled area, with no AI involved.
    func copyCircleText() {
        guard let capture = circle, !capture.text.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(capture.text, forType: .string)
        circle = nil
        report = []
        reportMessage = L("circle.copied", ["count": String(capture.text.count)])
        state = .done
        showReport(seconds: 3)
    }

    /// Adds a picture of an app's window to a request, when asked for and allowed. Otherwise the request goes as it is.
    private func attachWindowPicture(to params: JSONObject, pid: pid_t, include: Bool, send: @escaping (JSONObject) -> Void) {
        guard include, pid != 0, #available(macOS 14.0, *), Permissions.screenRecording == .granted else {
            send(params)
            return
        }
        Task { @MainActor in
            var out = params
            if let image = try? await ScreenGrabber.captureWindow(pid: pid), let encoded = ImagePrep.encode(image) {
                out["images"] = [["mediaType": encoded.mediaType, "data": encoded.base64] as JSONObject]
            }
            send(out)
        }
    }

    /// Forgets the conversation: the next request starts from nothing.
    func newChat() {
        speaker.stop()
        core.request("conversation.reset") { [weak self] _ in
            guard let self else { return }
            self.report = []
            self.reportMessage = L("chat.new_started")
            self.state = .done
            self.showReport(seconds: 3)
        }
    }

    func speakSample() {
        speakReply(L("settings.tts.sample"))
    }

    /// Reads a reply aloud: with the hosted voice when one is chosen, otherwise (or if that fails) with the Mac's own.
    func speakReply(_ reply: String) {
        let voiceId = settings["tts.voice"] as? String ?? ""
        let rate = settings["tts.rate"] as? Double ?? 0.5
        guard let provider = settings["tts.provider"] as? String, !provider.isEmpty else {
            speaker.speak(reply, voiceId: voiceId, rate: rate)
            return
        }
        let text = SpeechText.clean(reply, limit: 2400)
        guard !text.isEmpty else { return }
        speaker.stop()
        let ticket = speaker.generation
        core.request("tts.synthesize", ["text": text], timeout: 45) { [weak self] result in
            // Something newer started or stopped speaking while the voice was being made.
            guard let self, self.speaker.generation == ticket else { return }
            switch result {
            case let .success(value):
                if let object = value as? JSONObject, let encoded = object["audio"] as? String,
                   let data = Data(base64Encoded: encoded), self.speaker.play(data) {
                    return
                }
            case let .failure(error):
                self.notice = L("tts.cloud_failed", ["error": error.localizedDescription])
            }
            self.speaker.speak(reply, voiceId: voiceId, rate: rate)
        }
    }

    func stopSpeaking() { speaker.stop() }

    func cancelCurrentRequest() {
        cancelListening()
        if let task = activeTasks.first { cancelTask(task.id) }
    }

    func cancelListening() {
        tapCancel?.cancel()
        tapCancel = nil
        queuedRecovery = nil
        replayOnRelease = nil
        reviewEdit(false)
        stopLivePreview()
        _ = audio.stop()
        core.request("dictation.cancel")
        state = .idle
    }

    func reviewEdit(_ allow: Bool) {
        guard let review = editReview else { return }
        editReview = nil
        if allow {
            hidePanel()
            insertionTarget?.restore()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { review.reply(.success(["approved": true])) }
        } else { review.reply(.success(["approved": false])) }
    }

    func recover(_ entry: RecoveryEntry, retry: Bool) {
        guard ![ShellState.listening, .transcribing, .cleaning, .inserting].contains(state), editReview == nil else { return }
        queuedRecovery = (entry, retry)
        hidePanel()
        notice = "Focus the destination\(retry && entry.mode == "edit" ? " and select text" : ""), then press and release \(hotkeyName). Escape cancels."
        reportMessage = notice
        showReport(seconds: 10)
    }

    func clearRecovery() {
        recovery = []
        queuedRecovery = nil
    }

    func askFromPanel(_ text: String) {
        let request = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !request.isEmpty else { return }
        action = .agent
        state = .agent
        core.request("agent.run", ["transcript": request], timeout: 120) { [weak self] result in
            if case let .failure(error) = result { self?.showError(error.localizedDescription) }
        }
    }

    func retryDictation() {
        reportVisible = false
        state = .transcribing
        insertionTarget = InsertionTarget.capture()
        core.request("dictation.start")
        core.request("dictation.retry") { [weak self] result in
            if case let .failure(error) = result { self?.showError(error.localizedDescription) }
        }
    }

    private func finishQuietly() {
        guard !audio.isRecording else { return }
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
        case "models.progress", "models.done":
            speech.handle(method, params)
        case "chatgpt.login":
            switch params["state"] as? String {
            case "done":
                chatgpt.waiting = false
                chatgpt.code = nil
                chatgpt.error = nil
                refreshChatGpt()
                refreshSettings()
                refreshStatus()
            case "failed":
                chatgpt.waiting = false
                chatgpt.code = nil
                chatgpt.error = params["error"] as? String ?? "unknown error"
            default:
                break
            }
        case "composio.connect":
            switch params["state"] as? String {
            case "waiting":
                composio.connecting = params["toolkit"] as? String
                composio.error = nil
            case "done":
                composio.connecting = nil
                composio.error = nil
                refreshComposioApps()
            case "failed":
                composio.connecting = nil
                composio.error = params["error"] as? String
            default:
                break
            }
        case "state":
            guard let raw = params["state"] as? String, let next = ShellState(rawValue: raw) else { return }
            // Late events from the previous dictation must not hide the listening notch while the mic is open.
            if next == .listening || state == .listening || audio.isRecording { return }
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
        case "recovery.result":
            if let entry = RecoveryEntry(params) {
                recovery.insert(entry, at: 0)
                let keep = settings["recovery.sessionHistory"] as? Bool ?? false
                let limit = keep ? min(100, max(1, settings["recovery.limit"] as? Int ?? 20)) : 1
                recovery = Array(recovery.prefix(limit))
                if entry.status == "ready" || entry.status == "failed" { showPanel() }
            }
        case "dictation.task":
            action = .agent
            state = .agent
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
                if info.status == "done", previous?.isActive ?? true, !info.reply.isEmpty, settings["tts.enabled"] as? Bool ?? true {
                    speakReply(info.reply)
                }
                if !info.long, typingOpen, chatExpanded {
                    // The answer is already in the conversation, so no separate report card.
                    state = .idle
                } else if !info.long {
                    report = []
                    reportMessage = info.reply
                    state = .done
                    showReport(seconds: max(6, Double(info.reply.count) / 20))
                } else if activeTasks.isEmpty {
                    state = .idle
                }
                refreshHistory()
            }
        case "conversation.update":
            applyChat(params)
        case "approval.request":
            guard let json = params["preview"] as? JSONObject, let preview = Preview(json) else { return }
            if let index = approvals.firstIndex(where: { $0.callId == preview.callId }) {
                approvals[index] = preview
            } else {
                approvals.append(preview)
            }
        case "agents.update":
            guard let json = params["session"] as? JSONObject, let session = CodingAgentSession(json) else { return }
            if let index = agentSessions.firstIndex(where: { $0.id == session.id }) {
                agentSessions[index] = session
            } else {
                agentSessions.insert(session, at: 0)
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
        if key == "recovery.sessionHistory", value as? Bool != true { recovery = Array(recovery.prefix(1)) }
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

    /// Re-reads whether speech and the agent are configured.
    func refreshStatus() {
        core.request("status") { [weak self] status in
            if case let .success(info) = status, let info = info as? JSONObject {
                self?.llmReady = info["llm"] as? Bool ?? false
                self?.sttReady = info["stt"] as? Bool ?? false
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

    /// Looks for coding agents on this Mac and reads the runs Murmur has started.
    func refreshAgents() {
        core.request("agents.detect") { [weak self] result in
            guard case let .success(value) = result, let list = (value as? JSONObject)?["agents"] as? [JSONObject] else { return }
            self?.codingAgents = list.map(CodingAgentInfo.init)
        }
        core.request("agents.list") { [weak self] result in
            guard case let .success(value) = result, let list = (value as? JSONObject)?["sessions"] as? [JSONObject] else { return }
            self?.agentSessions = list.compactMap(CodingAgentSession.init)
        }
    }

    func stopAgent(_ id: String) {
        core.request("agents.stop", ["id": id])
    }

    /// Switches one coding agent on or off. The list is kept in the core's settings.
    func setAgentEnabled(_ kind: String, _ on: Bool) {
        var enabled = (settings["agents.enabled"] as? [String]) ?? ["codex", "claude", "opencode"]
        enabled.removeAll { $0 == kind }
        if on { enabled.append(kind) }
        setSetting("agents.enabled", enabled, then: { [weak self] _ in self?.refreshAgents() })
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

    /// Where a service's key is kept. Anthropic and "another server" keep the original single key.
    static func keyAccount(kind: String, id: String) -> String {
        if kind == "llm", id == "anthropic" || id == "openai-compatible" || id.isEmpty { return "llm/apiKey" }
        return "\(kind)/key/\(id)"
    }

    func hasKey(kind: String, id: String) -> Bool {
        Keychain.exists(AppModel.keyAccount(kind: kind, id: id))
    }

    /// Stores a key in the Keychain for one service. The core reads it from there when it needs it.
    func saveProviderKey(kind: String, id: String, key: String) {
        apiKeyError = nil
        let account = AppModel.keyAccount(kind: kind, id: id)
        if key.isEmpty {
            Keychain.delete(account)
        } else if case let .failure(error) = Keychain.save(account, key) {
            apiKeyError = L("settings.llm.key_failed", ["error": error.localizedDescription])
        }
        apiKeySaved = Keychain.exists("llm/apiKey")
        keyRevision += 1
        refreshStatus()
    }

    func saveApiKey(_ key: String) {
        saveProviderKey(kind: "llm", id: settings["llm.provider"] as? String ?? "anthropic", key: key)
        setSetting("llm.provider", settings["llm.provider"] ?? "anthropic")
    }

    func refreshProviders() {
        core.request("providers.catalog") { [weak self] result in
            guard case let .success(value) = result, let json = value as? JSONObject else { return }
            self?.catalog = ProviderCatalog(json)
        }
    }

    func refreshChatGpt() {
        core.request("chatgpt.status") { [weak self] result in
            guard let self, case let .success(value) = result, let info = value as? JSONObject else { return }
            self.chatgpt.signedIn = info["signedIn"] as? Bool ?? false
            self.chatgpt.email = info["email"] as? String
        }
    }

    /// Asks the core for a code, shows it, and opens OpenAI's page where it is entered.
    func startChatGptLogin() {
        chatgpt.error = nil
        chatgpt.waiting = true
        core.request("chatgpt.login.start") { [weak self] result in
            guard let self else { return }
            switch result {
            case let .success(value):
                guard let info = value as? JSONObject else { return }
                self.chatgpt.code = info["userCode"] as? String
                self.chatgpt.url = info["url"] as? String
                self.openChatGptPage()
            case let .failure(error):
                self.chatgpt.waiting = false
                self.chatgpt.error = error.localizedDescription
            }
        }
    }

    func openChatGptPage() {
        if let text = chatgpt.url, let url = URL(string: text), url.scheme == "https" { NSWorkspace.shared.open(url) }
    }

    func cancelChatGptLogin() {
        core.request("chatgpt.login.cancel")
        chatgpt.waiting = false
        chatgpt.code = nil
    }

    func signOutChatGpt() {
        core.request("chatgpt.logout") { [weak self] _ in
            self?.refreshChatGpt()
            self?.refreshSettings()
            self?.refreshStatus()
        }
    }

    // MARK: Composio

    func refreshComposio() {
        core.request("composio.status") { [weak self] result in
            guard let self, case let .success(value) = result, let info = value as? JSONObject else { return }
            self.composio.hasKey = info["hasKey"] as? Bool ?? false
            if self.composio.hasKey { self.refreshComposioApps() } else { self.composio.apps = [] }
        }
    }

    func refreshComposioApps(query: String = "") {
        composio.loading = true
        core.request("composio.apps", ["query": query], timeout: 60) { [weak self] result in
            guard let self else { return }
            self.composio.loading = false
            switch result {
            case let .success(value):
                let list = (value as? JSONObject)?["apps"] as? [JSONObject] ?? []
                self.composio.apps = list.map {
                    ComposioApp(
                        slug: $0["slug"] as? String ?? "",
                        name: $0["name"] as? String ?? "",
                        description: $0["description"] as? String ?? "",
                        connected: $0["connected"] as? Bool ?? false,
                        enabled: $0["enabled"] as? Bool ?? true,
                        readOnly: $0["readOnly"] as? Bool ?? false
                    )
                }
                // Connected apps first, then Composio's own order.
                self.composio.apps = self.composio.apps.filter(\.connected) + self.composio.apps.filter { !$0.connected }
            case let .failure(error):
                self.composio.error = error.localizedDescription
            }
        }
    }

    func saveComposioKey(_ key: String) {
        composio.error = nil
        core.request("composio.setKey", ["key": key], timeout: 40) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success:
                self.composio.hasKey = true
                self.composio.keySaved = true
                self.refreshComposioApps()
            case let .failure(error):
                self.composio.error = error.localizedDescription
            }
        }
    }

    func removeComposioKey() {
        core.request("composio.removeKey") { [weak self] _ in
            self?.composio = ComposioState()
        }
    }

    func connectComposioApp(_ slug: String) {
        composio.error = nil
        composio.connecting = slug
        core.request("composio.connect", ["app": slug]) { [weak self] result in
            if case let .failure(error) = result {
                self?.composio.connecting = nil
                self?.composio.error = error.localizedDescription
            }
        }
    }

    func disconnectComposioApp(_ slug: String) {
        core.request("composio.disconnect", ["app": slug], timeout: 40) { [weak self] result in
            if case let .failure(error) = result { self?.composio.error = error.localizedDescription }
            self?.refreshComposioApps()
        }
    }

    func configureComposioApp(_ slug: String, enabled: Bool? = nil, readOnly: Bool? = nil) {
        if let index = composio.apps.firstIndex(where: { $0.slug == slug }) {
            if let enabled { composio.apps[index].enabled = enabled }
            if let readOnly { composio.apps[index].readOnly = readOnly }
        }
        var params: JSONObject = ["app": slug]
        if let enabled { params["enabled"] = enabled }
        if let readOnly { params["readOnly"] = readOnly }
        core.request("composio.configure", params)
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

    private var stuckTicks = 0

    /// Two failure modes leave the microphone on with nothing on screen: the state moved away from
    /// listening while recording, or the key release was never seen (the event tap was switched off for a moment).
    /// Both are caught here after two seconds in a row, so the mic can't stay open.
    private func checkMicrophoneIsNotStuck() {
        let problem = MicGuard.problem(
            recording: audio.isRecording, state: state, toggleMode: hotkey.toggleMode,
            tapRunning: hotkey.isRunning, keyHeld: hotkey.isPhysicallyHeld, locked: hotkey.isLocked)
        guard let problem else { stuckTicks = 0; return }
        let lostRelease = problem == .releaseLost
        stuckTicks += 1
        guard stuckTicks >= 2 else { return }
        stuckTicks = 0
        NSLog("Murmur: microphone was open with state %@; releasing (lostRelease=%d)", state.rawValue, lostRelease ? 1 : 0)
        hotkey.forceRelease()
        if lostRelease {
            hotkeyUp()
        } else {
            _ = audio.stop()
            core.request("dictation.cancel")
            state = .idle
        }
    }

    /// The tap made at launch goes stale when Accessibility is switched off and on, or when macOS disables it.
    /// This only reads status and never prompts; it rebuilds the tap after a re-grant or when it stops running.
    private func watchHotkey() {
        hotkeyWatch?.invalidate()
        hotkeyWatch = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.checkMicrophoneIsNotStuck()
            let granted = Permissions.accessibility == .granted
            defer { self.accessibilityWasGranted = granted }
            guard granted, self.state != .listening else { return }
            if !self.hotkey.isRunning {
                if self.hotkey.start() { NSLog("Murmur: hotkey started after permission change") }
            } else if !self.hotkey.isEnabled || !self.accessibilityWasGranted {
                let wasEnabled = self.hotkey.isEnabled
                self.hotkey.stop()
                let started = self.hotkey.start()
                NSLog("Murmur: hotkey tap rebuilt (wasEnabled=%d, wasGranted=%d), started=%d",
                      wasEnabled ? 1 : 0, self.accessibilityWasGranted ? 1 : 0, started ? 1 : 0)
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
