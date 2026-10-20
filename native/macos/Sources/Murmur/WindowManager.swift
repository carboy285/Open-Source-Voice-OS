import AppKit
import SwiftUI

/// A borderless panel that can still take keyboard focus (for the side panel's search field).
final class KeyablePanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

/// Creates and positions every window. Views animate their own content; windows only appear and disappear.
final class WindowManager: NSObject, NSWindowDelegate {
    unowned let model: AppModel
    private var panel: KeyablePanel?
    private var settings: NSWindow?
    private var onboarding: NSWindow?
    private var panelHide: DispatchWorkItem?

    /// Listening, change report, approval, task progress and the waiting badge, all at the notch.
    lazy var notch = NotchController(model: model)

    static let panelWidth: CGFloat = 380

    init(model: AppModel) {
        self.model = model
    }

    private var activeScreen: NSScreen {
        NotchGeometry.pointerScreen() ?? NSScreen.screens[0]
    }

    // MARK: Notch

    /// Picks the notch surface again after the state, report, approvals or tasks changed.
    func updateNotch() {
        notch.update()
    }

    /// Focuses the approval card at the notch (the side panel's Review button).
    func showApproval() {
        notch.focusApproval()
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
            let rect = NSRect(x: 0, y: 0, width: SettingsLayout.width, height: SettingsLayout.height)
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

    var onboardingIsKey: Bool { onboarding?.isKeyWindow ?? false }

    var onboardingVisible: Bool { onboarding?.isVisible ?? false }

    func closeOnboarding() {
        UserDefaults.standard.set(true, forKey: "onboarded")
        model.stopPermissionPolling()
        model.cancelSetupPractice()
        onboarding?.close()
    }

    func windowWillClose(_ notification: Notification) {
        if (notification.object as? NSWindow) === onboarding { model.stopPermissionPolling(); model.cancelSetupPractice() }
    }
}
