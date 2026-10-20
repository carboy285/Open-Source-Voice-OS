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

/// One line of a preview card: an icon and a text, some pills, or a short paragraph.
struct CardRowInfo: Identifiable {
    let id = UUID()
    let icon: String
    let style: String
    let label: String?
    let values: [String]
}

/// How the core wants a preview drawn: an event, an email, a reminder... The shell only draws it.
struct PreviewCard {
    let kind: String
    let icon: String
    let app: String
    let title: String
    let rows: [CardRowInfo]
    let badgeIcon: String?
    let badgeText: String?

    init?(_ json: JSONObject?) {
        guard let json, let title = json["title"] as? String else { return nil }
        kind = json["kind"] as? String ?? "generic"
        icon = json["icon"] as? String ?? "tool"
        app = json["app"] as? String ?? ""
        self.title = title
        rows = (json["rows"] as? [JSONObject] ?? []).compactMap { row in
            let values = (row["values"] as? [Any] ?? []).map { String(describing: $0) }.filter { !$0.isEmpty }
            guard !values.isEmpty else { return nil }
            return CardRowInfo(
                icon: row["icon"] as? String ?? "text",
                style: row["style"] as? String ?? "text",
                label: row["label"] as? String,
                values: values
            )
        }
        let badge = json["badge"] as? JSONObject
        badgeIcon = badge?["icon"] as? String
        badgeText = badge?["text"] as? String
    }

    /// SF Symbol for a row icon id from the core.
    static func symbol(_ icon: String) -> String {
        switch icon {
        case "clock": return "clock"
        case "person": return "person"
        case "pin": return "mappin.and.ellipse"
        case "video": return "video"
        case "folder": return "folder"
        case "list": return "list.bullet"
        case "link": return "link"
        default: return "text.alignleft"
        }
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
    let card: PreviewCard?
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
        card = PreviewCard(json["card"] as? JSONObject)
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

/// One thing the agent ran during a request, shown small under the reply in the chat.
struct ChatAction: Identifiable {
    let id = UUID()
    let summary: String
    let failed: Bool
}

/// One request and its answer in the chat history the core keeps for the conversation.
struct ChatEntry: Identifiable {
    let id: Int
    let request: String
    let reply: String
    /// "done", "failed" or "cancelled".
    let status: String
    let actions: [ChatAction]

    init?(_ json: JSONObject) {
        guard let id = json["id"] as? Int else { return nil }
        self.id = id
        request = json["request"] as? String ?? ""
        reply = json["reply"] as? String ?? ""
        status = json["status"] as? String ?? "done"
        actions = (json["actions"] as? [JSONObject] ?? []).map {
            ChatAction(summary: $0["summary"] as? String ?? $0["tool"] as? String ?? "", failed: $0["isError"] as? Bool ?? false)
        }
    }
}

/// An AI, speech-to-text or text-to-speech service the core knows how to use, for the pickers in Settings.
struct ServiceInfo: Identifiable {
    let id: String
    let name: String
    let defaultModel: String
    let defaultVoice: String
    let keyUrl: String
    let url: String
    /// Runs on this computer, so it needs no key.
    let local: Bool
    /// Its usual model can look at pictures.
    let vision: Bool

    init(_ json: JSONObject) {
        id = json["id"] as? String ?? ""
        name = json["name"] as? String ?? id
        defaultModel = json["defaultModel"] as? String ?? ""
        defaultVoice = json["defaultVoice"] as? String ?? ""
        keyUrl = json["keyUrl"] as? String ?? ""
        url = json["url"] as? String ?? ""
        local = json["local"] as? Bool ?? false
        vision = json["vision"] as? Bool ?? false
    }
}

struct ProviderCatalog {
    var llm: [ServiceInfo] = []
    var stt: [ServiceInfo] = []
    var tts: [ServiceInfo] = []

    init() {}

    init(_ json: JSONObject) {
        func list(_ key: String) -> [ServiceInfo] { (json[key] as? [JSONObject] ?? []).map(ServiceInfo.init) }
        llm = list("llm")
        stt = list("stt")
        tts = list("tts")
    }
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
    case "agent": return "terminal"
    case "computer": return "desktopcomputer"
    default: return "wrench.and.screwdriver"
    }
}

/// A coding agent Murmur found on this Mac (Codex, Claude Code, OpenCode).
struct CodingAgentInfo: Identifiable {
    let id: String
    let label: String
    let installed: Bool
    let enabled: Bool
    let version: String
    let hint: String

    init(_ json: JSONObject) {
        id = json["kind"] as? String ?? ""
        label = json["label"] as? String ?? id
        installed = json["installed"] as? Bool ?? false
        enabled = json["enabled"] as? Bool ?? false
        version = json["version"] as? String ?? ""
        hint = json["hint"] as? String ?? ""
    }
}

/// One run of a coding agent that Murmur started.
struct CodingAgentSession: Identifiable {
    let id: String
    let label: String
    let cwd: String
    let task: String
    let status: String
    let text: String
    let startedAt: Double

    init?(_ json: JSONObject) {
        guard let id = json["id"] as? String else { return nil }
        self.id = id
        label = json["label"] as? String ?? ""
        cwd = json["cwd"] as? String ?? ""
        task = json["task"] as? String ?? ""
        status = json["status"] as? String ?? ""
        text = json["text"] as? String ?? ""
        startedAt = json["startedAt"] as? Double ?? 0
    }

    var isActive: Bool { ["starting", "working", "needs_you", "idle"].contains(status) }
}
