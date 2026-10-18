import AppKit

/// The view that catches the drag and draws the loop. Flipped, so a point is already "screen-local, top left".
final class CircleDrawView: NSView {
    private(set) var path: [CGPoint] = []
    private(set) var dragging = false
    var onFinish: (([CGPoint]) -> Void)?

    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.activeAlways, .mouseMoved, .mouseEnteredAndExited, .inVisibleRect], owner: self))
    }

    override func mouseEntered(with event: NSEvent) { NSCursor.crosshair.set() }
    override func mouseMoved(with event: NSEvent) { NSCursor.crosshair.set() }

    override func mouseDown(with event: NSEvent) {
        path = [convert(event.locationInWindow, from: nil)]
        dragging = true
        needsDisplay = true
    }

    override func mouseDragged(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if let last = path.last, hypot(point.x - last.x, point.y - last.y) < 2 { return }
        path.append(point)
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        dragging = false
        let drawn = path
        path = []
        needsDisplay = true
        onFinish?(drawn)
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.black.withAlphaComponent(0.2).setFill()
        bounds.fill()
        guard path.count > 1 else { return }
        let line = NSBezierPath()
        line.move(to: path[0])
        path.dropFirst().forEach { line.line(to: $0) }
        line.lineWidth = 4
        line.lineCapStyle = .round
        line.lineJoinStyle = .round
        NSGraphicsContext.saveGraphicsState()
        let glow = NSShadow()
        glow.shadowColor = NSColor(calibratedRed: 0.30, green: 0.50, blue: 0.98, alpha: 0.9)
        glow.shadowBlurRadius = 12
        glow.set()
        NSColor(calibratedRed: 0.55, green: 0.70, blue: 1.0, alpha: 1).setStroke()
        line.stroke()
        NSGraphicsContext.restoreGraphicsState()
    }
}

/// A transparent sheet over one screen while the circle key is held. Drag to draw; the loop's box is what Murmur looks at.
final class CircleOverlay {
    private var window: NSPanel?
    private var view: CircleDrawView?
    private var cursorPushed = false

    var isShowing: Bool { window != nil }
    var isDragging: Bool { view?.dragging ?? false }

    /// `onFinish` gets the box around the loop in screen-local points (top left origin), or nothing when it was too small.
    func show(on screen: NSScreen, onFinish: @escaping (CGRect?) -> Void) {
        hide()
        let panel = NSPanel(contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.level = .screenSaver
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.ignoresMouseEvents = false
        panel.animationBehavior = .none
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        let draw = CircleDrawView(frame: NSRect(origin: .zero, size: screen.frame.size))
        draw.onFinish = { path in
            let bounds = CGRect(origin: .zero, size: screen.frame.size)
            onFinish(CircleGeometry.region(path: path, bounds: bounds))
        }
        panel.contentView = draw
        panel.orderFrontRegardless()
        NSCursor.crosshair.push()
        cursorPushed = true
        window = panel
        view = draw
    }

    func hide() {
        if cursorPushed {
            NSCursor.pop()
            cursorPushed = false
        }
        window?.orderOut(nil)
        window = nil
        view = nil
    }
}
