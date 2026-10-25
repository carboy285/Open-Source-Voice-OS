import AppKit
import ApplicationServices

/// Kept only in the shell, so field contents and AX references do not cross the RPC boundary.
struct InsertionTarget {
    let pid: pid_t
    let element: AXUIElement
    let window: AXUIElement?
    let value: String?
    let range: CFRange?

    static func capture() -> InsertionTarget? {
        guard AXIsProcessTrusted(), let app = NSWorkspace.shared.frontmostApplication,
              let field = AX.focusedElement(), !AX.isSecure(field) else { return nil }
        let value = AX.string(field, kAXValueAttribute)
        let range = selectedRange(field)
        guard value != nil || range != nil else { return nil }
        let application = AXUIElementCreateApplication(app.processIdentifier)
        return InsertionTarget(pid: app.processIdentifier, element: field,
            window: AX.element(application, kAXFocusedWindowAttribute), value: value, range: range)
    }

    var isCurrent: Bool {
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
              let current = AX.focusedElement(), CFEqual(element, current), !AX.isSecure(current) else { return false }
        if let window {
            guard let currentWindow = AX.element(AXUIElementCreateApplication(pid), kAXFocusedWindowAttribute),
                  CFEqual(window, currentWindow) else { return false }
        }
        if let value, AX.string(current, kAXValueAttribute) != value { return false }
        if let range {
            guard let currentRange = Self.selectedRange(current), currentRange.location == range.location,
                  currentRange.length == range.length else { return false }
        }
        return true
    }

    func restore() {
        guard let app = NSRunningApplication(processIdentifier: pid) else { return }
        // The review button explicitly requests returning to this destination. Validation still runs after activation.
        app.activate(options: [.activateIgnoringOtherApps])
    }

    private static func selectedRange(_ element: AXUIElement) -> CFRange? {
        guard let raw = AX.attribute(element, kAXSelectedTextRangeAttribute), CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
        var range = CFRange()
        return AXValueGetValue(raw as! AXValue, .cfRange, &range) ? range : nil
    }
}

struct RecoveryEntry: Identifiable {
    let id: String
    let mode: String
    let transcript: String
    let text: String
    let status: String
    let error: String?
    init?(_ json: JSONObject) {
        guard let id = json["id"] as? String else { return nil }
        self.id = id; mode = json["mode"] as? String ?? "dictate"
        transcript = json["transcript"] as? String ?? ""
        text = json["text"] as? String ?? ""; status = json["status"] as? String ?? "ready"
        error = json["error"] as? String
    }
}

struct EditReview {
    let before: String
    let after: String
    let reply: (Result<Any, Error>) -> Void
}
