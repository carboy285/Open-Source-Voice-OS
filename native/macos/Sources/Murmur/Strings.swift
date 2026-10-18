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
        return table[plural] != nil ? self(plural, all) : self(key, all)
    }

    /// Shown only until the core answers.
    private static let fallback: [String: String] = [
        "app.name": "Murmur",
        "menu.state.starting": "Starting",
        "menu.quit": "Quit Murmur",
        "error.core_stopped": "Murmur's engine stopped. Restarting…",
    ]
}

let L = Strings.shared
