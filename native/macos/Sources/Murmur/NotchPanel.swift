import AppKit

/// The one window behind every notch surface. Borderless and non-activating: it appears without taking focus,
/// and can become key only while the controller asks for it (a click on the approval card or the focus shortcut).
/// Its frame stays fixed at the largest card size; SwiftUI animates the shape inside it.
final class NotchPanel: NSPanel {
    /// True only while focus was explicitly requested.
    var allowsKey = false
    /// Called before a mouse-down is delivered, so a click can focus the card first.
    var onMouseDown: (() -> Void)?

    override var canBecomeKey: Bool { allowsKey }
    override var canBecomeMain: Bool { false }

    func configure() {
        isFloatingPanel = true
        level = .statusBar
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        hidesOnDeactivate = false
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        isMovable = false
        isReleasedWhenClosed = false
        becomesKeyOnlyIfNeeded = false
        acceptsMouseMovedEvents = true
        animationBehavior = .none
        // Transparent until a surface shows; the controller turns mouse events on over the visible shape only.
        ignoresMouseEvents = true
    }

    /// Keep the top edge flush with the top of the screen, over the menu bar.
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        frameRect
    }

    override func sendEvent(_ event: NSEvent) {
        if event.type == .leftMouseDown || event.type == .rightMouseDown {
            onMouseDown?()
        }
        super.sendEvent(event)
    }
}
