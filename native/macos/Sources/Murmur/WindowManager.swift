import AppKit
import SwiftUI

/// A borderless panel that can still take keyboard focus (for the side panel's search field).
final class KeyablePanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

/// Creates and positions every window. Views animate their own content; windows only appear and disappear.
final class WindowManager: NSObject, NSWindowDelegate {
    unowned let model: AppModel
    private var indicator: NSPanel?
    private var approval: NSPanel?
    private var dim: NSWindow?
    private var panel: KeyablePanel?
    private var settings: NSWindow?
    private var onboarding: NSWindow?
    private var indicatorHide: DispatchWorkItem?
    private var panelHide: DispatchWorkItem?

    static let indicatorSize = NSSize(width: 380, height: 340)
    static let panelWidth: CGFloat = 380

    init(model: AppModel) {
        self.model = model
    }

    private var activeScreen: NSScreen {
        let mouse = NSEvent.mouseLocation
        return NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main ?? NSScreen.screens[0]
    }

    /// Where the indicator capsule sits on screen; popovers and the approval preview grow from here.
    var indicatorPoint: NSPoint {
        guard let frame = indicator?.frame else {
            let visible = activeScreen.visibleFrame
            return NSPoint(x: visible.midX, y: visible.minY + 40)
        }
        return NSPoint(x: frame.midX, y: frame.minY + 26)
    }

    // MARK: Indicator

    func showIndicator() {
        indicatorHide?.cancel()
        if indicator == nil {
            let window = NSPanel(
                contentRect: NSRect(origin: .zero, size: WindowManager.indicatorSize),
                styleMask: [.borderless, .nonactivatingPanel],
                backing: .buffered,
                defer: false
            )
            window.isFloatingPanel = true
            window.level = .statusBar
            window.backgroundColor = .clear
            window.isOpaque = false
            window.hasShadow = false
            window.hidesOnDeactivate = false
            window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
            window.contentView = NSHostingView(rootView: IndicatorView().environmentObject(model).environmentObject(L))
            indicator = window
        }
        guard let window = indicator else { return }
        if !window.isVisible {
            let visible = activeScreen.visibleFrame
            window.setFrameOrigin(NSPoint(x: visible.midX - WindowManager.indicatorSize.width / 2, y: visible.minY + 16))
        }
        window.orderFrontRegardless()
        model.indicatorVisible = true
    }

    func hideIndicator() {
        model.indicatorVisible = false
        model.reportVisible = false
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.model.indicatorVisible else { return }
            self.indicator?.orderOut(nil)
        }
        indicatorHide = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6, execute: work)
    }

    // MARK: Approval

    /// Shows the first pending preview, dimming the screen behind it. Closes both when none is left.
    func showApproval() {
        guard !model.approvals.isEmpty else {
            approval?.orderOut(nil)
            dim?.orderOut(nil)
            return
        }
        let screen = activeScreen
        if dim == nil {
            let window = NSWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
            window.backgroundColor = NSColor.black.withAlphaComponent(0.22)
            window.isOpaque = false
            window.level = .floating
            window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            dim = window
        }
        dim?.setFrame(screen.frame, display: false)
        if approval == nil {
            let window = NSPanel(
                contentRect: NSRect(x: 0, y: 0, width: 480, height: 360),
                styleMask: [.titled, .closable, .fullSizeContentView],
                backing: .buffered,
                defer: false
            )
            window.titlebarAppearsTransparent = true
            window.titleVisibility = .hidden
            window.isMovableByWindowBackground = true
            window.level = .modalPanel
            window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            window.delegate = self
            window.backgroundColor = .clear
            let hosting = NSHostingController(rootView: ApprovalHost().environmentObject(model).environmentObject(L))
            hosting.sizingOptions = [.preferredContentSize]
            window.contentViewController = hosting
            approval = window
        }
        guard let window = approval else { return }
        if !window.isVisible {
            let visible = screen.visibleFrame
            let size = window.frame.size
            window.setFrameOrigin(NSPoint(x: visible.midX - size.width / 2, y: visible.midY - size.height / 2 + 60))
        }
        dim?.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    /// Unit point of the indicator inside the approval window, so the preview grows from it.
    var approvalAnchor: UnitPoint {
        guard let frame = approval?.frame, frame.width > 0, frame.height > 0 else { return .bottom }
        let point = indicatorPoint
        let x = min(max((point.x - frame.minX) / frame.width, 0), 1)
        let y = min(max(1 - (point.y - frame.minY) / frame.height, 0), 1)
        return UnitPoint(x: x, y: y)
    }

    /// Closing the preview window means Cancel.
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if sender === approval, let preview = model.approvals.first {
            model.respond(preview, decision: "cancel")
            return false
        }
        return true
    }

    // MARK: Side panel

    func showPanel() {
        panelHide?.cancel()
        if panel == nil {
            let window = KeyablePanel(
                contentRect: NSRect(x: 0, y: 0, width: WindowManager.panelWidth, height: 600),
                styleMask: [.borderless, .nonactivatingPanel],
                backing: .buffered,
                defer: false
            )
            window.isFloatingPanel = true
            window.becomesKeyOnlyIfNeeded = true
            window.level = .floating
            window.backgroundColor = .clear
            window.isOpaque = false
            window.hasShadow = false
            window.hidesOnDeactivate = false
            window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            window.contentView = NSHostingView(rootView: SidePanelView().environmentObject(model).environmentObject(L))
            panel = window
        }
        guard let window = panel else { return }
        if !window.isVisible {
            let visible = activeScreen.visibleFrame
            window.setFrame(
                NSRect(x: visible.maxX - WindowManager.panelWidth - 8, y: visible.minY + 8, width: WindowManager.panelWidth, height: visible.height - 16),
                display: true
            )
        }
        window.orderFrontRegardless()
    }

    /// Orders the panel out once its slide-out has settled, unless it was reopened in the meantime.
    func schedulePanelHide() {
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.model.panelVisible else { return }
            self.panel?.orderOut(nil)
        }
        panelHide = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.7, execute: work)
    }

    // MARK: Settings and onboarding

    func showSettings() {
        if settings == nil {
            // Size the hosting view before it joins a window; a first layout at zero width logs "width is negative".
            let rect = NSRect(x: 0, y: 0, width: 620, height: 480)
            let hosting = NSHostingController(rootView: SettingsView().environmentObject(model).environmentObject(L))
            hosting.sizingOptions = []
            hosting.view.frame = rect
            let window = NSWindow(contentRect: rect, styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
            window.contentViewController = hosting
            window.setContentSize(rect.size)
            window.isReleasedWhenClosed = false
            settings = window
        }
        settings?.title = L("settings.title")
        model.refreshConnectors()
        model.refreshSettings()
        settings?.center()
        NSApp.activate(ignoringOtherApps: true)
        settings?.makeKeyAndOrderFront(nil)
    }

    func showOnboarding() {
        if onboarding == nil {
            let window = NSWindow(contentViewController: NSHostingController(rootView: OnboardingView().environmentObject(model).environmentObject(L)))
            window.styleMask = [.titled, .closable]
            window.isReleasedWhenClosed = false
            window.delegate = self
            onboarding = window
        }
        onboarding?.title = L("onboarding.title")
        model.startPermissionPolling()
        onboarding?.center()
        NSApp.activate(ignoringOtherApps: true)
        onboarding?.makeKeyAndOrderFront(nil)
    }

    var onboardingVisible: Bool { onboarding?.isVisible ?? false }

    func closeOnboarding() {
        UserDefaults.standard.set(true, forKey: "onboarded")
        model.stopPermissionPolling()
        onboarding?.close()
    }

    func windowWillClose(_ notification: Notification) {
        if (notification.object as? NSWindow) === onboarding { model.stopPermissionPolling() }
    }
}
