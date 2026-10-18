import AppKit
import ApplicationServices
import os

/// Reads accessibility attributes without force-casting CF types.
enum AX {
    static func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }

    static func string(_ element: AXUIElement, _ name: String) -> String? {
        attribute(element, name) as? String
    }

    static func element(_ element: AXUIElement, _ name: String) -> AXUIElement? {
        guard let value = attribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement)
    }

    static func focusedElement() -> AXUIElement? {
        element(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute)
    }

    static func isSettable(_ element: AXUIElement, _ name: String) -> Bool {
        var settable = DarwinBoolean(false)
        return AXUIElementIsAttributeSettable(element, name as CFString, &settable) == .success && settable.boolValue
    }

    static func isSecure(_ element: AXUIElement) -> Bool {
        let role = string(element, kAXRoleAttribute) ?? ""
        let subrole = string(element, kAXSubroleAttribute) ?? ""
        return role == "AXSecureTextField" || subrole == "AXSecureTextField"
    }
}

/// Puts text at the caret: accessibility first, then paste, then typing.
///
/// macOS drops synthetic keystrokes without telling the sender when the grant is stale, so each route is
/// checked by reading the focused element before and after. When the text could not be placed it stays on
/// the clipboard and the caller is told. Logs hold roles, bundle ids and error codes, never dictated text.
enum TextInserter {
    enum Method: String {
        case accessibility, paste, typing, clipboard
    }

    struct Outcome {
        let ok: Bool
        let method: Method
        /// Set when the text was not placed (or could not be confirmed): a short code for the log and the shell.
        let reason: String?
    }

    private static let log = Logger(subsystem: "app.murmur", category: "insert")

    static func insert(_ text: String) -> Outcome {
        let trusted = AXIsProcessTrusted()
        let canPost = CGPreflightPostEventAccess()
        let app = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "unknown"
        let element = AX.focusedElement()
        let role = element.flatMap { AX.string($0, kAXRoleAttribute) } ?? "none"
        let subrole = element.flatMap { AX.string($0, kAXSubroleAttribute) } ?? "none"
        let listen = CGPreflightListenEventAccess()
        log.info("insert app=\(app, privacy: .public) role=\(role, privacy: .public) subrole=\(subrole, privacy: .public) trusted=\(trusted, privacy: .public) post=\(canPost, privacy: .public) listen=\(listen, privacy: .public) length=\(text.count, privacy: .public)")

        if let element, AX.isSecure(element) {
            log.info("insert refused: secure field")
            return Outcome(ok: false, method: .clipboard, reason: "secure")
        }

        let settable = element.map { AX.isSettable($0, kAXSelectedTextAttribute) } ?? false
        let routes = InsertPlan.routes(trusted: trusted, canPost: canPost, axSettable: settable, length: text.utf16.count)
        log.info("insert routes=\(routes.map(\.rawValue).joined(separator: ","), privacy: .public)")

        for route in routes {
            let before = snapshot()
            let attempted: Bool
            switch route {
            case .accessibility:
                attempted = setSelectedText(element, text)
            case .paste:
                attempted = pasteKeys(text)
            case .typing:
                attempted = typeText(text)
            }
            guard attempted else { continue }
            let verdict = confirm(before: before)
            log.info("insert route=\(route.rawValue, privacy: .public) changed=\(String(describing: verdict), privacy: .public)")
            switch verdict {
            case .some(true):
                restoreClipboardLater()
                return Outcome(ok: true, method: method(route), reason: nil)
            case .none:
                // Nothing readable to compare (some Electron apps). Trust the post, but keep the text on the clipboard.
                leaveOnClipboard(text)
                return Outcome(ok: true, method: method(route), reason: "unverified")
            case .some(false):
                continue
            }
        }

        leaveOnClipboard(text)
        let reason = InsertPlan.failureReason(trusted: trusted, canPost: canPost)
        log.error("insert failed reason=\(reason, privacy: .public)")
        return Outcome(ok: false, method: .clipboard, reason: reason)
    }

    private static func method(_ route: InsertPlan.Route) -> Method {
        switch route {
        case .accessibility: return .accessibility
        case .paste: return .paste
        case .typing: return .typing
        }
    }

    // MARK: Verification

    private static func snapshot() -> InsertPlan.Snapshot {
        guard let element = AX.focusedElement() else { return InsertPlan.Snapshot() }
        var caret: Int?
        if let raw = AX.attribute(element, kAXSelectedTextRangeAttribute), CFGetTypeID(raw) == AXValueGetTypeID() {
            var range = CFRange()
            if AXValueGetValue(raw as! AXValue, .cfRange, &range) { caret = range.location &+ range.length }
        }
        return InsertPlan.Snapshot(value: AX.string(element, kAXValueAttribute), caret: caret)
    }

    /// Polls for up to 400 ms for the focused element to change. `nil` when it exposes nothing to compare.
    private static func confirm(before: InsertPlan.Snapshot) -> Bool? {
        var last: Bool?
        for _ in 0..<10 {
            Thread.sleep(forTimeInterval: 0.04)
            last = InsertPlan.changed(before: before, after: snapshot())
            if last == true { return true }
            if last == nil { return nil }
        }
        return last
    }

    // MARK: Routes

    private static func setSelectedText(_ element: AXUIElement?, _ text: String) -> Bool {
        guard let element else { return false }
        let status = AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute as CFString, text as CFString)
        log.info("insert ax.set status=\(status.rawValue, privacy: .public)")
        return status == .success
    }

    private static var savedClipboard: [[NSPasteboard.PasteboardType: Data]] = []
    private static var insertedChangeCount: Int?

    /// Puts the text on the clipboard and sends Cmd+V. The old clipboard comes back only after a confirmed insert.
    private static func pasteKeys(_ text: String) -> Bool {
        let board = NSPasteboard.general
        savedClipboard = (board.pasteboardItems ?? []).map { item in
            var entry: [NSPasteboard.PasteboardType: Data] = [:]
            for type in item.types { if let data = item.data(forType: type) { entry[type] = data } }
            return entry
        }
        board.clearContents()
        board.setString(text, forType: .string)
        insertedChangeCount = board.changeCount
        return postKey(9, flags: .maskCommand) // kVK_ANSI_V
    }

    private static func restoreClipboardLater() {
        guard let count = insertedChangeCount else { return }
        let saved = savedClipboard
        insertedChangeCount = nil
        savedClipboard = []
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            let board = NSPasteboard.general
            guard board.changeCount == count else { return }
            board.clearContents()
            let items = saved.map { entry -> NSPasteboardItem in
                let item = NSPasteboardItem()
                for (type, data) in entry { item.setData(data, forType: type) }
                return item
            }
            if !items.isEmpty { board.writeObjects(items) }
        }
    }

    private static func leaveOnClipboard(_ text: String) {
        insertedChangeCount = nil
        savedClipboard = []
        let board = NSPasteboard.general
        board.clearContents()
        board.setString(text, forType: .string)
    }

    private static func postKey(_ code: CGKeyCode, flags: CGEventFlags) -> Bool {
        // A private source carries only the flags set here, so a key still being released can't leak in.
        let source = CGEventSource(stateID: .privateState)
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else {
            log.error("insert key event could not be created")
            return false
        }
        down.flags = flags
        up.flags = flags
        down.post(tap: .cgSessionEventTap)
        up.post(tap: .cgSessionEventTap)
        return true
    }

    private static func typeText(_ text: String) -> Bool {
        let source = CGEventSource(stateID: .privateState)
        let units = Array(text.utf16)
        var index = 0
        while index < units.count {
            let chunk = Array(units[index..<min(index + 20, units.count)])
            guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else { return false }
            chunk.withUnsafeBufferPointer { buffer in
                down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
                up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
            }
            down.post(tap: .cgSessionEventTap)
            up.post(tap: .cgSessionEventTap)
            index += 20
        }
        return true
    }
}

/// What the user is working in, captured at hotkey-down.
enum ContextCapture {
    static func capture() -> JSONObject {
        var result: JSONObject = [:]
        let app = NSWorkspace.shared.frontmostApplication
        result["appId"] = app?.bundleIdentifier ?? ""
        result["appName"] = app?.localizedName ?? ""
        guard AXIsProcessTrusted() else { return result }
        if let pid = app?.processIdentifier {
            let appElement = AXUIElementCreateApplication(pid)
            if let window = AX.element(appElement, kAXFocusedWindowAttribute) {
                result["windowTitle"] = AX.string(window, kAXTitleAttribute) ?? ""
            }
        }
        if let focused = AX.focusedElement() {
            result["role"] = AX.string(focused, kAXRoleAttribute) ?? ""
            if AX.isSecure(focused) {
                result["secure"] = true
                return result
            }
            if let selection = AX.string(focused, kAXSelectedTextAttribute), !selection.isEmpty {
                result["selection"] = String(selection.prefix(4000))
            }
            if let value = AX.string(focused, kAXValueAttribute) {
                result["focusedText"] = String(value.prefix(4000))
            }
        }
        let mouse = NSEvent.mouseLocation
        let screenHeight = NSScreen.screens.first?.frame.height ?? 0
        var under: AXUIElement?
        if AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(mouse.x), Float(screenHeight - mouse.y), &under) == .success,
           let under {
            let text = AX.string(under, kAXValueAttribute) ?? AX.string(under, kAXTitleAttribute) ?? AX.string(under, kAXDescriptionAttribute)
            if let text, !text.isEmpty { result["underPointer"] = String(text.prefix(4000)) }
        }
        return result
    }
}
