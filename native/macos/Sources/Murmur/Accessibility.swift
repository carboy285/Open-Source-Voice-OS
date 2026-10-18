import AppKit
import ApplicationServices

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
enum TextInserter {
    enum Method: String {
        case accessibility, paste, typing, clipboard
    }

    static func insert(_ text: String) -> (ok: Bool, method: Method) {
        if let element = AX.focusedElement() {
            if AX.isSecure(element) { return (false, .clipboard) }
            if AX.isSettable(element, kAXSelectedTextAttribute),
               AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute as CFString, text as CFString) == .success {
                return (true, .accessibility)
            }
        }
        if AXIsProcessTrusted() {
            if paste(text) { return (true, .paste) }
            if text.utf16.count <= 2000, typeText(text) { return (true, .typing) }
        }
        let board = NSPasteboard.general
        board.clearContents()
        board.setString(text, forType: .string)
        return (false, .clipboard)
    }

    /// Saves the clipboard, pastes, and restores the clipboard 500 ms later.
    private static func paste(_ text: String) -> Bool {
        let board = NSPasteboard.general
        let saved: [[NSPasteboard.PasteboardType: Data]] = (board.pasteboardItems ?? []).map { item in
            var entry: [NSPasteboard.PasteboardType: Data] = [:]
            for type in item.types { if let data = item.data(forType: type) { entry[type] = data } }
            return entry
        }
        board.clearContents()
        board.setString(text, forType: .string)
        let changeCount = board.changeCount
        guard postKey(9, flags: .maskCommand) else { return false } // kVK_ANSI_V
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            guard board.changeCount == changeCount else { return }
            board.clearContents()
            let items = saved.map { entry -> NSPasteboardItem in
                let item = NSPasteboardItem()
                for (type, data) in entry { item.setData(data, forType: type) }
                return item
            }
            if !items.isEmpty { board.writeObjects(items) }
        }
        return true
    }

    private static func postKey(_ code: CGKeyCode, flags: CGEventFlags) -> Bool {
        let source = CGEventSource(stateID: .combinedSessionState)
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else { return false }
        down.flags = flags
        up.flags = flags
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
        return true
    }

    private static func typeText(_ text: String) -> Bool {
        let source = CGEventSource(stateID: .combinedSessionState)
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
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
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
