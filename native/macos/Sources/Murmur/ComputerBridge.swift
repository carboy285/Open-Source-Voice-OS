import AppKit
import ApplicationServices
import Foundation
import os

private let log = Logger(subsystem: "app.murmur", category: "computer")

/// Answers the core's `apple.call` for the "computer" service: list and quit apps, read what an app is showing,
/// and press, type and choose menu items through the Accessibility API.
///
/// Every call here reaches this code only after the user approved it in the notch (reading and listing excepted).
/// Murmur's own windows are never touched, so the agent can't press its own "Approve" button, and password
/// managers, terminals and System Settings are off limits. Secure text fields are never read or typed into.
enum ComputerBridge {
    private static let queue = DispatchQueue(label: "app.murmur.computer")
    /// Elements from the last look at the screen. An id is only good until the next look.
    private static var registry: [String: AXUIElement] = [:]

    private static let blockedPrefixes = [
        "com.apple.systempreferences", "com.apple.keychainaccess", "com.apple.passwords", "com.apple.securityagent",
        "com.apple.terminal", "com.googlecode.iterm2", "dev.warp", "net.kovidgoyal.kitty", "com.mitchellh.ghostty",
        "co.zeit.hyper", "com.1password", "com.agilebits", "com.bitwarden", "com.lastpass", "org.keepassxc",
        "com.dashlane", "com.apple.screensharing",
    ]

    static func call(action: String, args: JSONObject, reply: @escaping (Result<Any, Error>) -> Void) {
        queue.async {
            let result: Result<Any, Error>
            do {
                result = .success(try run(action, args))
            } catch {
                result = .failure(error)
            }
            DispatchQueue.main.async { reply(result) }
        }
    }

    private static func fail(_ message: String) -> Error {
        CoreError.remote(code: -1, message: message)
    }

    // MARK: Apps

    private static func isBlocked(_ app: NSRunningApplication) -> Bool {
        let id = (app.bundleIdentifier ?? "").lowercased()
        if id == (Bundle.main.bundleIdentifier ?? "app.murmur").lowercased() { return true }
        return blockedPrefixes.contains { id.hasPrefix($0) }
    }

    private static func regularApps() -> [NSRunningApplication] {
        NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
    }

    private static func find(_ name: String) throws -> NSRunningApplication {
        let wanted = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !wanted.isEmpty else { throw fail("Say which app.") }
        let apps = regularApps()
        let match = apps.first { ($0.localizedName ?? "").lowercased() == wanted || ($0.bundleIdentifier ?? "").lowercased() == wanted }
            ?? apps.first { ($0.localizedName ?? "").lowercased().contains(wanted) }
        guard let match else { throw fail("\(name) isn't open.") }
        return match
    }

    /// The app to work on: the one named, or the one in front. Never Murmur, and never a blocked app.
    private static func target(_ name: Any?) throws -> NSRunningApplication {
        let app: NSRunningApplication
        if let name = name as? String, !name.isEmpty {
            app = try find(name)
        } else if let front = NSWorkspace.shared.frontmostApplication, front.bundleIdentifier != Bundle.main.bundleIdentifier {
            app = front
        } else {
            throw fail("Say which app to use.")
        }
        if isBlocked(app) {
            throw fail("Murmur doesn't control \(app.localizedName ?? "that app"). It is kept off limits for your safety.")
        }
        return app
    }

    private static func requireTrust() throws {
        guard AXIsProcessTrusted() else {
            throw fail("Murmur needs Accessibility permission. Allow it in System Settings > Privacy & Security > Accessibility, then try again.")
        }
    }

    // MARK: Dispatch

    private static func run(_ action: String, _ args: JSONObject) throws -> Any {
        switch action {
        case "apps":
            let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
            let items: [JSONObject] = regularApps().map {
                ["name": $0.localizedName ?? "", "bundleId": $0.bundleIdentifier ?? "", "active": $0.processIdentifier == front]
            }
            return ["items": items]
        case "quit":
            let app = try target(args["app"])
            guard app.bundleIdentifier != "com.apple.finder" else { throw fail("Finder can't be quit.") }
            // A polite quit: an app with unsaved work asks the user what to do, as it would from its own menu.
            guard app.terminate() else { throw fail("\(app.localizedName ?? "The app") didn't quit.") }
            return ["name": app.localizedName ?? ""]
        case "ui_read": return try read(args)
        case "ui_click": return try click(args)
        case "ui_type": return try typeIn(args)
        case "ui_key": return try key(args)
        case "menu": return try menu(args)
        default: throw fail("Unknown computer action \(action).")
        }
    }

    // MARK: Reading

    private static let pressable: Set<String> = [
        "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXLink", "AXMenuItem", "AXTab",
        "AXDisclosureTriangle", "AXComboBox", "AXSegmentedControl", "AXSlider",
    ]
    private static let fields: Set<String> = ["AXTextField", "AXTextArea", "AXSearchField"]

    private static func children(_ element: AXUIElement) -> [AXUIElement] {
        (AX.attribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
    }

    private static func label(_ element: AXUIElement, role: String) -> String {
        for name in [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute] {
            if let text = AX.string(element, name)?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
                return String(text.prefix(80))
            }
        }
        if role == "AXStaticText", let text = AX.string(element, kAXValueAttribute)?.trimmingCharacters(in: .whitespacesAndNewlines) {
            return String(text.prefix(100))
        }
        return ""
    }

    private static func read(_ args: JSONObject) throws -> Any {
        try requireTrust()
        let app = try target(args["app"])
        let root = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(root, 2)
        let window = AX.element(root, kAXFocusedWindowAttribute)
            ?? (AX.attribute(root, kAXWindowsAttribute) as? [AXUIElement])?.first
        guard let window else { throw fail("\(app.localizedName ?? "That app") has no open window to read.") }

        registry = [:]
        var items: [JSONObject] = []
        var queueOfElements: [(AXUIElement, Int)] = [(window, 0)]
        var cursor = 0
        while cursor < queueOfElements.count, items.count < 150 {
            let (element, depth) = queueOfElements[cursor]
            cursor += 1
            let role = AX.string(element, kAXRoleAttribute) ?? ""
            let secure = AX.isSecure(element)
            if pressable.contains(role) || fields.contains(role) || role == "AXStaticText" {
                let text = label(element, role: role)
                if !text.isEmpty || fields.contains(role) {
                    let id = "e\(items.count + 1)"
                    registry[id] = element
                    var item: JSONObject = ["id": id, "role": role, "label": text]
                    if secure {
                        item["secure"] = true
                    } else if fields.contains(role), let value = AX.string(element, kAXValueAttribute) {
                        item["value"] = String(value.prefix(120))
                    }
                    if let enabled = AX.attribute(element, kAXEnabledAttribute) as? Bool, !enabled { item["enabled"] = false }
                    items.append(item)
                }
            }
            if depth < 9 {
                for child in children(element) { queueOfElements.append((child, depth + 1)) }
            }
        }
        let menus = AX.element(root, kAXMenuBarAttribute).map { children($0) }?.compactMap { AX.string($0, kAXTitleAttribute) } ?? []
        return [
            "app": app.localizedName ?? "",
            "window": AX.string(window, kAXTitleAttribute) ?? "",
            "items": items,
            "menus": menus.filter { !$0.isEmpty },
            "truncated": cursor < queueOfElements.count,
        ] as JSONObject
    }

    // MARK: Acting

    /// The element from the last look, if it is still what the user was shown.
    private static func known(_ args: JSONObject) throws -> (element: AXUIElement, app: NSRunningApplication) {
        try requireTrust()
        guard let id = args["id"] as? String, let element = registry[id] else {
            throw fail("That item is from an older look at the screen. Read the screen again.")
        }
        var pid: pid_t = 0
        AXUIElementGetPid(element, &pid)
        guard let app = NSRunningApplication(processIdentifier: pid), !isBlocked(app) else {
            throw fail("Murmur doesn't control that app.")
        }
        let role = AX.string(element, kAXRoleAttribute) ?? ""
        if let expected = args["role"] as? String, !expected.isEmpty, expected != role {
            throw fail("That item changed. Read the screen again.")
        }
        if let expected = args["label"] as? String, expected != label(element, role: role) {
            throw fail("That item changed. Read the screen again.")
        }
        return (element, app)
    }

    private static func click(_ args: JSONObject) throws -> Any {
        let (element, app) = try known(args)
        if AXUIElementPerformAction(element, kAXPressAction as CFString) != .success {
            // Text fields and the like can't be pressed; clicking one means putting the cursor in it.
            guard AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success else {
                throw fail("That item can't be clicked.")
            }
        }
        return ["app": app.localizedName ?? ""]
    }

    private static func typeIn(_ args: JSONObject) throws -> Any {
        try requireTrust()
        guard let text = args["text"] as? String, !text.isEmpty else { throw fail("There is nothing to type.") }
        let app = try target(args["app"])
        if args["id"] is String {
            let (element, _) = try known(args)
            if AX.isSecure(element) { throw fail("Murmur doesn't type into password fields.") }
            AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        }
        app.activate(options: [])
        Thread.sleep(forTimeInterval: 0.3)
        let root = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(root, 2)
        if let focused = AX.element(root, kAXFocusedUIElementAttribute), AX.isSecure(focused) {
            throw fail("Murmur doesn't type into password fields.")
        }
        guard CGPreflightPostEventAccess() else {
            throw fail("Murmur needs permission to control the keyboard. Allow it in System Settings > Privacy & Security > Accessibility.")
        }
        let source = CGEventSource(stateID: .privateState)
        let units = Array(text.utf16)
        var index = 0
        while index < units.count {
            let chunk = Array(units[index..<min(index + 20, units.count)])
            guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
                throw fail("Couldn't type.")
            }
            chunk.withUnsafeBufferPointer { buffer in
                down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
                up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
            }
            down.postToPid(app.processIdentifier)
            up.postToPid(app.processIdentifier)
            index += 20
            Thread.sleep(forTimeInterval: 0.01)
        }
        log.info("typed \(units.count) characters into \(app.bundleIdentifier ?? "an app", privacy: .public)")
        return ["app": app.localizedName ?? "", "characters": units.count]
    }

    private static let keyCodes: [String: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13,
        "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
        "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "return": 36,
        "enter": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46,
        ".": 47, "tab": 48, "space": 49, "`": 50, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
        "left": 123, "right": 124, "down": 125, "up": 126,
    ]

    private static func key(_ args: JSONObject) throws -> Any {
        try requireTrust()
        let app = try target(args["app"])
        let combo = (args["keys"] as? String ?? "").lowercased().split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces) }
        guard let last = combo.last, let code = keyCodes[last] else { throw fail("I don't know the key \"\(args["keys"] as? String ?? "")\".") }
        var flags: CGEventFlags = []
        for modifier in combo.dropLast() {
            switch modifier {
            case "cmd", "command": flags.insert(.maskCommand)
            case "shift": flags.insert(.maskShift)
            case "option", "alt": flags.insert(.maskAlternate)
            case "ctrl", "control": flags.insert(.maskControl)
            default: throw fail("I don't know the modifier \"\(modifier)\".")
            }
        }
        guard CGPreflightPostEventAccess() else {
            throw fail("Murmur needs permission to control the keyboard. Allow it in System Settings > Privacy & Security > Accessibility.")
        }
        app.activate(options: [])
        Thread.sleep(forTimeInterval: 0.3)
        let source = CGEventSource(stateID: .privateState)
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else { throw fail("Couldn't press the key.") }
        down.flags = flags
        up.flags = flags
        down.postToPid(app.processIdentifier)
        up.postToPid(app.processIdentifier)
        return ["app": app.localizedName ?? ""]
    }

    private static func menu(_ args: JSONObject) throws -> Any {
        try requireTrust()
        let app = try target(args["app"])
        guard let path = args["path"] as? [String], !path.isEmpty else { throw fail("Give the menu path, like File, New Window.") }
        let root = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(root, 2)
        guard var current = AX.element(root, kAXMenuBarAttribute) else { throw fail("\(app.localizedName ?? "That app") has no menu bar to use.") }
        for (index, title) in path.enumerated() {
            var options = children(current)
            if options.count == 1, AX.string(options[0], kAXRoleAttribute) == "AXMenu" { options = children(options[0]) }
            let wanted = title.trimmingCharacters(in: .whitespaces).lowercased()
            guard let next = options.first(where: { (AX.string($0, kAXTitleAttribute) ?? "").lowercased() == wanted }) else {
                throw fail("I couldn't find \"\(title)\" in the menu.")
            }
            if index == path.count - 1 {
                if let enabled = AX.attribute(next, kAXEnabledAttribute) as? Bool, !enabled { throw fail("\"\(title)\" is greyed out right now.") }
                guard AXUIElementPerformAction(next, kAXPressAction as CFString) == .success else { throw fail("Couldn't choose \"\(title)\".") }
            }
            current = next
        }
        return ["app": app.localizedName ?? "", "item": path.last ?? ""]
    }
}
