import AppKit
import ApplicationServices

/// Kept only in the shell, so field contents and AX references do not cross the RPC boundary.
///
/// A target is captured when the hotkey goes down and checked again before text is placed. Many web and Electron
/// fields expose neither a value nor a selection, so capture never requires them: when there is nothing to compare
/// the check answers "unknown" and the insertion is allowed rather than refusing a dictation that had no problem.
struct InsertionTarget {
    /// What can be said about the destination a moment later.
    enum Verdict {
        /// Same app, window and field, and nothing observably changed.
        case current
        /// The destination is gone or something about it changed: do not type into it.
        case changed
        /// Same app and window, but the app exposes too little to prove the field is identical.
        case unknown
    }

    let pid: pid_t
    let element: AXUIElement
    let window: AXUIElement?
    let role: String?
    let subrole: String?
    let value: String?
    let range: CFRange?

    static func capture() -> InsertionTarget? {
        guard AXIsProcessTrusted(), let app = NSWorkspace.shared.frontmostApplication,
              let field = AX.focusedElement(), !AX.isSecure(field) else { return nil }
        let application = AXUIElementCreateApplication(app.processIdentifier)
        return InsertionTarget(
            pid: app.processIdentifier,
            element: field,
            window: AX.element(application, kAXFocusedWindowAttribute),
            role: AX.string(field, kAXRoleAttribute),
            subrole: AX.string(field, kAXSubroleAttribute),
            value: AX.string(field, kAXValueAttribute),
            range: selectedRange(field),
        )
    }

    /// False only when the destination demonstrably changed. Unknown counts as fine.
    var isCurrent: Bool { verdict != .changed }

    var verdict: Verdict {
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
              let current = AX.focusedElement(), !AX.isSecure(current) else { return .changed }
        if let value, let now = AX.string(current, kAXValueAttribute), now != value { return .changed }
        if let range, let now = Self.selectedRange(current), now.location != range.location || now.length != range.length {
            return .changed
        }
        if let window, let currentWindow = AX.element(AXUIElementCreateApplication(pid), kAXFocusedWindowAttribute),
           !CFEqual(window, currentWindow) {
            return .changed
        }
        if CFEqual(element, current) { return .current }
        // WebKit and Electron rebuild AX wrappers, so identity is not stable. Matching role, subrole and window is
        // as much as those apps expose; assume the caret is still where it was instead of rejecting the text.
        let currentRole = AX.string(current, kAXRoleAttribute)
        if let role, role == currentRole {
            if subrole == nil || subrole == AX.string(current, kAXSubroleAttribute) { return .unknown }
        }
        return .changed
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
