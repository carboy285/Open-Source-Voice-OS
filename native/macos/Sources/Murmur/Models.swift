import Foundation

struct PreviewField: Identifiable {
    var id: String { key }
    let key: String
    let label: String
    let type: String
    let value: Any

    var text: String {
        if let list = value as? [Any] { return list.map { "\($0)" }.joined(separator: ", ") }
        if let string = value as? String { return string }
        if value is NSNull { return "" }
        if let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]),
           let string = String(data: data, encoding: .utf8) { return string }
        return "\(value)"
    }
}

/// An approval preview built by the core from the connector's own summary.
struct Preview: Identifiable {
    var id: String { callId }
    let callId: String
    let tool: String
    let displayName: String
    let icon: String
    let verb: String
    let summary: String
    let fields: [PreviewField]
    let raw: JSONObject
    let destructive: Bool
    let edited: Bool
    let confirming: Bool
    let errors: [String]
    let expiresAt: Date

    init?(_ json: JSONObject) {
        guard let callId = json["callId"] as? String else { return nil }
        self.callId = callId
        tool = json["tool"] as? String ?? ""
        displayName = json["displayName"] as? String ?? tool
        icon = json["icon"] as? String ?? "tool"
        verb = json["verb"] as? String ?? "Run"
        summary = json["summary"] as? String ?? ""
        fields = (json["fields"] as? [JSONObject] ?? []).map {
            PreviewField(key: $0["key"] as? String ?? "", label: $0["label"] as? String ?? "", type: $0["type"] as? String ?? "text", value: $0["value"] ?? "")
        }
        raw = json["raw"] as? JSONObject ?? [:]
        destructive = (json["risk"] as? String) == "destructive"
        edited = (json["state"] as? String) == "edited"
        confirming = (json["stage"] as? String) == "confirm"
        errors = json["errors"] as? [String] ?? []
        expiresAt = Date(timeIntervalSince1970: (json["expiresAt"] as? Double ?? 0) / 1000)
    }
}

struct TaskStep: Identifiable {
    var id: Int { seq }
    let seq: Int
    let tool: String
    let inputSummary: String
    let resultSummary: String
    let approval: String

    init(_ json: JSONObject) {
        seq = json["seq"] as? Int ?? 0
        tool = json["tool"] as? String ?? ""
        inputSummary = json["inputSummary"] as? String ?? ""
        resultSummary = json["resultSummary"] as? String ?? ""
        approval = json["approval"] as? String ?? "auto"
    }
}

struct TaskInfo: Identifiable {
    let id: String
    var status: String
    var steps: [TaskStep]
    var long: Bool
    var reply: String
    var currentStep: String?
    var transcript: String?
    var startedAt: Date

    init(update json: JSONObject) {
        id = json["taskId"] as? String ?? json["id"] as? String ?? UUID().uuidString
        status = json["status"] as? String ?? "running"
        steps = (json["steps"] as? [JSONObject] ?? []).map(TaskStep.init)
        long = json["long"] as? Bool ?? false
        reply = json["reply"] as? String ?? ""
        currentStep = json["currentStep"] as? String
        transcript = json["transcript"] as? String
        startedAt = Date(timeIntervalSince1970: (json["startedAt"] as? Double ?? Date().timeIntervalSince1970 * 1000) / 1000)
    }

    var isActive: Bool { status == "running" || status == "waiting_approval" }
}

struct ReportItem: Identifiable {
    var id: String { category }
    let category: String
    let count: Int
    let label: String
}

struct ConnectorInfo: Identifiable {
    let id: String
    let name: String
    let description: String
    let icon: String
    let skeleton: Bool
    var enabled: Bool
    let auth: String
}

struct McpServerInfo: Identifiable {
    var id: String { name }
    let name: String
    let state: String
    let tools: Int
}

/// SF Symbols used for connector icon ids.
func symbol(forIcon icon: String) -> String {
    switch icon {
    case "globe": return "globe"
    case "folder": return "folder"
    case "note": return "note.text"
    case "bell": return "bell"
    case "mail": return "envelope"
    case "calendar": return "calendar"
    case "chat": return "bubble.left.and.bubble.right"
    case "doc": return "doc.text"
    case "issue": return "checklist"
    case "cloud": return "icloud"
    case "mcp": return "puzzlepiece.extension"
    default: return "wrench.and.screwdriver"
    }
}
