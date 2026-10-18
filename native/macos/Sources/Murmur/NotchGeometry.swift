import AppKit

/// Where the camera notch is on a screen, or where Murmur draws its own pill when the screen has none (`notch.md`).
struct NotchGeometry: Equatable {
    /// The screen's full frame, in global screen coordinates.
    let screenFrame: NSRect
    /// The notch, or the pill on a screen without one, in global screen coordinates. Its top edge is the top of the screen.
    let notchRect: NSRect
    /// False when Murmur draws its own pill.
    let hasNotch: Bool
    /// The display the rect belongs to, so a screen change can find the same display again.
    let displayID: UInt32

    /// About the size of a real notch.
    static let pillSize = NSSize(width: 200, height: 32)

    var notchSize: CGSize { notchRect.size }

    init(screen: NSScreen?) {
        guard let screen else {
            let frame = NSRect(x: 0, y: 0, width: 1440, height: 900)
            screenFrame = frame
            notchRect = NotchGeometry.pill(in: frame)
            hasNotch = false
            displayID = 0
            return
        }
        let frame = screen.frame
        screenFrame = frame
        displayID = NotchGeometry.screenNumber(of: screen)
        // The notch is the gap between the two unobscured top areas, as tall as the top safe-area inset.
        let top = screen.safeAreaInsets.top
        if top > 0, let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea {
            let width = frame.width - left.width - right.width
            if width > 40, width < frame.width / 2 {
                notchRect = NSRect(x: frame.minX + left.width, y: frame.maxY - top, width: width, height: top)
                hasNotch = true
                return
            }
        }
        notchRect = NotchGeometry.pill(in: frame)
        hasNotch = false
    }

    private static func pill(in frame: NSRect) -> NSRect {
        NSRect(
            x: frame.midX - pillSize.width / 2,
            y: frame.maxY - pillSize.height,
            width: pillSize.width,
            height: pillSize.height
        )
    }

    static func screenNumber(of screen: NSScreen) -> UInt32 {
        let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber
        return number?.uint32Value ?? 0
    }

    /// The screen under the pointer, or the main screen.
    static func pointerScreen() -> NSScreen? {
        let mouse = NSEvent.mouseLocation
        return NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main ?? NSScreen.screens.first
    }

    /// The screen with this display id, if it is still connected.
    static func screen(withID id: UInt32) -> NSScreen? {
        NSScreen.screens.first { screenNumber(of: $0) == id }
    }
}
