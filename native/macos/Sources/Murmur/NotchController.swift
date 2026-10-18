import AppKit
import SwiftUI

/// What the notch shows. Only one surface at a time; waiting approvals add a badge beside it.
enum NotchSurface: Equatable {
    case hidden
    case listening
    case report
    case approval(String)
    case progress(String)

    var key: String {
        switch self {
        case .hidden: return "hidden"
        case .listening: return "listening"
        case .report: return "report"
        case let .approval(id): return "approval-\(id)"
        case let .progress(id): return "progress-\(id)"
        }
    }

    var isApproval: Bool {
        if case .approval = self { return true }
        return false
    }
}

/// Owns the notch panel, picks the surface by the priority in `notch.md`, and handles focus.
/// AppModel calls `update()` whenever the state, the report, the approvals or the tasks change.
final class NotchController: NSObject, ObservableObject, NSWindowDelegate {
    unowned let model: AppModel

    @Published private(set) var surface: NotchSurface = .hidden
    @Published private(set) var geometry: NotchGeometry
    @Published private(set) var focused = false
    @Published var reportExpanded = false
    /// Natural content heights reported by the views, by kind ("report", "approval").
    @Published private(set) var measured: [String: CGFloat] = [:]

    private var panel: NotchPanel?
    private var previousApp: NSRunningApplication?
    private var monitors: [Any] = []
    private var screenObserver: NSObjectProtocol?

    static let panelWidth: CGFloat = 640
    static let badgeGap: CGFloat = 6
    static let badgeWidth: CGFloat = 140
    static let listeningExtra: CGFloat = 30
    static let approvalWidth: CGFloat = 460
    static let reportWidth: CGFloat = 380

    init(model: AppModel) {
        self.model = model
        geometry = NotchGeometry(screen: NotchGeometry.pointerScreen())
        super.init()
        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.screensChanged()
        }
    }

    // MARK: Sizes

    /// The panel never resizes while showing; it is as large as the largest card.
    var panelSize: CGSize {
        let height = min(560, max(320, geometry.screenFrame.height * 0.75))
        return CGSize(width: NotchController.panelWidth, height: height)
    }

    private var panelFrame: NSRect {
        let size = panelSize
        return NSRect(
            x: geometry.notchRect.midX - size.width / 2,
            y: geometry.screenFrame.maxY - size.height,
            width: size.width,
            height: size.height
        )
    }

    /// The tallest a scrolling card's content can be, below the notch.
    var maxContentHeight: CGFloat {
        panelSize.height - geometry.notchSize.height - 16
    }

    /// The size the shape grows to for the current surface.
    var shapeSize: CGSize { shapeSize(for: surface) }

    /// The size the shape grows to for a surface. Hidden is the notch itself.
    func shapeSize(for surface: NotchSurface) -> CGSize {
        let notch = geometry.notchSize
        switch surface {
        case .hidden:
            return notch
        case .listening:
            return CGSize(width: max(320, notch.width + 120), height: notch.height + NotchController.listeningExtra)
        case .progress:
            return CGSize(width: max(300, notch.width + 120), height: notch.height + NotchController.listeningExtra)
        case .report:
            return CGSize(
                width: max(NotchController.reportWidth, notch.width + 120),
                height: notch.height + contentHeight("report")
            )
        case .approval:
            return CGSize(
                width: max(NotchController.approvalWidth, notch.width + 40),
                height: notch.height + contentHeight("approval")
            )
        }
    }

    /// Bottom corner radius per surface; the hidden shape matches the notch's own corners.
    func cornerRadius(for surface: NotchSurface) -> CGFloat {
        switch surface {
        case .hidden: return 10
        case .listening, .progress: return 16
        case .report: return 18
        case .approval: return 22
        }
    }

    func contentHeight(_ kind: String) -> CGFloat {
        min(measured[kind] ?? 48, maxContentHeight)
    }

    func setMeasured(_ values: [String: CGFloat]) {
        var next = measured
        var changed = false
        for (kind, height) in values where abs((next[kind] ?? -1) - height) > 0.5 {
            next[kind] = height
            changed = true
        }
        guard changed else { return }
        measured = next
        refreshMouse()
    }

    /// A waiting approval shows as a badge beside whatever else holds the notch.
    var showsBadge: Bool {
        surface != .hidden && !surface.isApproval && !model.approvals.isEmpty
    }

    /// Approvals queued behind the one on the card.
    var queuedBehindCard: Int {
        surface.isApproval ? max(0, model.approvals.count - 1) : 0
    }

    // MARK: Priority

    /// Listening wins; then a change report; then approvals in arrival order; then task progress (`notch.md`).
    private func resolve() -> NotchSurface {
        switch model.state {
        case .listening, .transcribing, .cleaning, .inserting:
            return .listening
        default:
            break
        }
        if model.reportVisible { return .report }
        if let first = model.approvals.first { return .approval(first.callId) }
        let longTask = model.activeTasks.first { $0.long }
        if model.state == .agent {
            // A request still being worked on before it turns into a long task: keep showing the step.
            if let longTask { return .progress(longTask.id) }
            return .listening
        }
        if let longTask { return .progress(longTask.id) }
        return .hidden
    }

    /// Picks the surface again. Runs synchronously, so the listening surface is set in the same frame as the key press.
    func update() {
        // Build the panel early, so the first key press doesn't wait for a window to be created.
        ensurePanel()
        let next = resolve()
        guard next != surface else {
            refreshMouse()
            return
        }
        let previous = surface
        if previous == .hidden {
            // The next surface opens on the pointer's screen; an open one stays where it is.
            let fresh = NotchGeometry(screen: NotchGeometry.pointerScreen())
            if fresh != geometry { geometry = fresh }
        }
        if previous.isApproval { releaseFocus() }
        if next != .report { reportExpanded = false }
        placePanel()
        surface = next
        if next != .hidden { panel?.orderFrontRegardless() }
        announce(next)
        refreshMouse()
    }

    // MARK: Panel

    private func ensurePanel() {
        guard panel == nil else { return }
        let window = NotchPanel(
            contentRect: panelFrame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        window.configure()
        window.delegate = self
        window.onMouseDown = { [weak self] in self?.panelMouseDown() }
        let root = NotchRoot(controller: self).environmentObject(model).environmentObject(L)
        let hosting = NSHostingView(rootView: root)
        hosting.sizingOptions = []
        hosting.frame = NSRect(origin: .zero, size: panelSize)
        window.contentView = hosting
        window.setFrame(panelFrame, display: false)
        panel = window
        installMonitors()
    }

    /// Moves the fixed-size panel to the current notch. Never animated.
    private func placePanel() {
        guard let panel else { return }
        let frame = panelFrame
        if panel.frame != frame { panel.setFrame(frame, display: true) }
    }

    private func screensChanged() {
        // Stay on the same display if it is still there; otherwise move to the primary screen.
        let screen = NotchGeometry.screen(withID: geometry.displayID) ?? NSScreen.screens.first
        geometry = NotchGeometry(screen: screen)
        placePanel()
        refreshMouse()
    }

    // MARK: Mouse

    /// The visible shape (and badge) in screen coordinates. Everything else in the panel lets clicks through.
    private var interactiveRect: NSRect {
        guard surface != .hidden, let frame = panel?.frame else { return .zero }
        let size = shapeSize
        var rect = NSRect(x: frame.midX - size.width / 2, y: frame.maxY - size.height, width: size.width, height: size.height)
        if showsBadge {
            let height = geometry.notchSize.height
            let badge = NSRect(
                x: frame.midX + size.width / 2,
                y: frame.maxY - height,
                width: NotchController.badgeGap + NotchController.badgeWidth,
                height: height
            )
            rect = rect.union(badge)
        }
        return rect
    }

    private func installMonitors() {
        let mask: NSEvent.EventTypeMask = [.mouseMoved, .leftMouseDragged]
        if let global = NSEvent.addGlobalMonitorForEvents(matching: mask, handler: { [weak self] _ in
            self?.refreshMouse()
        }) {
            monitors.append(global)
        }
        if let local = NSEvent.addLocalMonitorForEvents(matching: mask, handler: { [weak self] event in
            self?.refreshMouse()
            return event
        }) {
            monitors.append(local)
        }
    }

    /// The panel takes mouse events only while the pointer is over the visible shape.
    func refreshMouse() {
        guard let panel else { return }
        let inside = interactiveRect.contains(NSEvent.mouseLocation)
        if panel.ignoresMouseEvents == inside { panel.ignoresMouseEvents = !inside }
    }

    private func panelMouseDown() {
        if surface.isApproval, !focused { focusApproval() }
    }

    // MARK: Focus

    /// Makes the approval card key: from a click on it, the focus shortcut, or the side panel's Review button.
    /// Listening keeps the notch; a change report gives way early.
    func focusApproval() {
        guard !model.approvals.isEmpty, model.state != .listening else { return }
        if surface == .report { model.dismissReport() }
        guard surface.isApproval, let panel else { return }
        if !focused {
            let front = NSWorkspace.shared.frontmostApplication
            if let front, front.processIdentifier != ProcessInfo.processInfo.processIdentifier {
                previousApp = front
            }
        }
        panel.allowsKey = true
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        focused = true
        refreshMouse()
    }

    /// The card closed: give up key status and hand focus back to the app that had it.
    private func releaseFocus() {
        guard focused || panel?.allowsKey == true else { return }
        focused = false
        panel?.allowsKey = false
        if panel?.isKeyWindow == true { panel?.resignKey() }
        if let app = previousApp, !app.isTerminated {
            app.activate(options: [])
        }
        previousApp = nil
    }

    /// The user clicked into another app: the card stays, unfocused. Clicking outside never cancels.
    func windowDidResignKey(_ notification: Notification) {
        guard (notification.object as? NSWindow) === panel else { return }
        focused = false
        panel?.allowsKey = false
        previousApp = nil
    }

    // MARK: Report

    /// Hovering expands the report and holds it open; leaving collapses it and restarts a short timer.
    func reportHover(_ hovering: Bool) {
        guard surface == .report else { return }
        reportExpanded = hovering
        model.holdReport(hovering)
    }

    // MARK: VoiceOver

    private func announce(_ next: NotchSurface) {
        let text: String
        switch next {
        case .hidden:
            return
        case .listening:
            guard model.state == .listening else { return }
            text = model.action == .agent ? L("indicator.agent") : L("indicator.listening")
        case .report:
            if let message = model.reportMessage, !message.isEmpty {
                text = message
            } else {
                text = model.report.map(\.label).joined(separator: ", ")
            }
        case let .approval(id):
            guard let preview = model.approvals.first(where: { $0.callId == id }) else { return }
            let summary = preview.summary.isEmpty ? preview.displayName : preview.summary
            text = L("notch.approval_needed", ["summary": summary])
        case let .progress(id):
            guard let task = model.tasks[id] else { return }
            text = task.currentStep ?? L("panel.status.\(task.status)")
        }
        guard !text.isEmpty else { return }
        NSAccessibility.post(
            element: NSApplication.shared,
            notification: .announcementRequested,
            userInfo: [
                NSAccessibility.NotificationUserInfoKey.announcement: text,
                NSAccessibility.NotificationUserInfoKey.priority: NSAccessibilityPriorityLevel.high.rawValue,
            ]
        )
    }
}
