import Foundation

/// UI strings come from the core's catalogs (English and Japanese), so both shells share one source.
final class Strings: ObservableObject {
    static let shared = Strings()
    @Published private(set) var table: [String: String] = [:]
    @Published private(set) var locale = "en"

    func load(_ strings: [String: String], locale: String) {
        table = strings
        self.locale = locale
    }

    func callAsFunction(_ key: String, _ params: [String: String] = [:]) -> String {
        var text = table[key] ?? Strings.fallback[key] ?? key
        for (name, value) in params { text = text.replacingOccurrences(of: "{\(name)}", with: value) }
        return text
    }

    /// Picks `.one` / `.other` like the core's t().
    func count(_ key: String, _ count: Int, _ params: [String: String] = [:]) -> String {
        var all = params
        all["count"] = String(count)
        let plural = "\(key).\(count == 1 ? "one" : "other")"
        return table[plural] != nil || Strings.fallback[plural] != nil ? self(plural, all) : self(key, all)
    }

    /// Shown only until the core answers. The notch keys are here too, since a surface can appear before the catalog loads.
    private static let fallback: [String: String] = [
        "app.name": "Murmur",
        "menu.state.starting": "Starting",
        "menu.quit": "Quit Murmur",
        "error.core_stopped": "Murmur's engine stopped. Restarting…",
        "notch.mode.dictate": "Dictate",
        "notch.mode.ask": "Ask",
        "notch.mode.edit": "Edit",
        "notch.waiting.one": "{count} waiting",
        "notch.waiting.other": "{count} waiting",
        "notch.waiting.hint": "Approvals are waiting. They show here when the notch is free.",
        "notch.approval_needed": "Approval needed: {summary}",
        "notch.focus_hint": "Click or press ⌃⌥Space to use the keyboard",
        "notch.keys_hint": "⌘Return to confirm · Esc to cancel",
        "notch.step": "Step {count}",
        "notch.open_tasks": "Open tasks",
        "notch.show_all": "Show all",
        "notch.show_less": "Show less",
        "notch.close": "Close",
    ]
}

let L = Strings.shared
