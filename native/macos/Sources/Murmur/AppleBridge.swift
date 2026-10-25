import AppKit
import EventKit
import Foundation
import os

private let log = Logger(subsystem: "app.murmur", category: "apple")

/// Answers the core's `apple.call` with the Mac's own Calendar, Reminders, Mail and Notes.
/// Calendar and Reminders use EventKit; Mail and Notes have no API, so they are driven with a short AppleScript run by
/// osascript. macOS asks the user once per app, and every request here names a connector the user turned on.
enum AppleBridge {
    private static let store = EKEventStore()

    static func call(service: String, action: String, args: JSONObject, reply: @escaping (Result<Any, Error>) -> Void) {
        switch service {
        case "calendar": calendar(action, args, reply)
        case "reminders": reminders(action, args, reply)
        case "mail": mail(action, args, reply)
        case "notes": notes(action, args, reply)
        case "computer": ComputerBridge.call(action: action, args: args, reply: reply)
        default: reply(.failure(fail("Unknown service \(service).")))
        }
    }

    private static func fail(_ message: String) -> Error {
        CoreError.remote(code: -1, message: message)
    }

    private static func ms(_ date: Date?) -> Any {
        date.map { Int($0.timeIntervalSince1970 * 1000) } ?? NSNull()
    }

    private static func date(_ value: Any?) -> Date? {
        guard let number = (value as? NSNumber)?.doubleValue else { return nil }
        return Date(timeIntervalSince1970: number / 1000)
    }

    private static func due(_ components: DateComponents?) -> Date? {
        guard let components else { return nil }
        return components.date ?? Calendar.current.date(from: components)
    }

    // MARK: Permission

    private static func access(_ type: EKEntityType, then run: @escaping (Bool) -> Void) {
        let done: (Bool, Error?) -> Void = { granted, error in
            if let error { log.error("EventKit access error: \(error.localizedDescription, privacy: .public)") }
            DispatchQueue.main.async { run(granted) }
        }
        if #available(macOS 14.0, *) {
            if type == .event { store.requestFullAccessToEvents(completion: done) } else { store.requestFullAccessToReminders(completion: done) }
        } else {
            store.requestAccess(to: type, completion: done)
        }
    }

    private static func denied(_ what: String) -> Error {
        fail("Murmur needs permission to use \(what). Allow it in System Settings > Privacy & Security > \(what), then try again.")
    }

    // MARK: Calendar

    private static func calendar(_ action: String, _ args: JSONObject, _ reply: @escaping (Result<Any, Error>) -> Void) {
        access(.event) { granted in
            guard granted else { return reply(.failure(denied("Calendars"))) }
            switch action {
            case "events":
                guard let from = date(args["fromMs"]), let to = date(args["toMs"]) else { return reply(.failure(fail("Missing dates."))) }
                var calendars = store.calendars(for: .event)
                if let name = args["calendar"] as? String, !name.isEmpty {
                    calendars = calendars.filter { $0.title.caseInsensitiveCompare(name) == .orderedSame }
                }
                let predicate = store.predicateForEvents(withStart: from, end: to, calendars: calendars)
                let events = store.events(matching: predicate).sorted { $0.startDate < $1.startDate }.prefix(60)
                let items: [JSONObject] = events.map {
                    [
                        "id": $0.eventIdentifier ?? "",
                        "title": $0.title ?? "",
                        "startMs": ms($0.startDate),
                        "endMs": ms($0.endDate),
                        "allDay": $0.isAllDay,
                        "calendar": $0.calendar.title,
                        "location": $0.location ?? "",
                    ]
                }
                reply(.success(["items": items]))
            case "create":
                guard let start = date(args["startMs"]), let end = date(args["endMs"]) else { return reply(.failure(fail("Missing dates."))) }
                let event = EKEvent(eventStore: store)
                event.title = args["title"] as? String ?? ""
                event.startDate = start
                event.endDate = end
                if let place = args["location"] as? String, !place.isEmpty { event.location = place }
                if let notes = args["notes"] as? String, !notes.isEmpty { event.notes = notes }
                let wanted = args["calendar"] as? String ?? ""
                let writable = store.calendars(for: .event).filter { $0.allowsContentModifications }
                guard let target = writable.first(where: { !wanted.isEmpty && $0.title.caseInsensitiveCompare(wanted) == .orderedSame })
                    ?? store.defaultCalendarForNewEvents ?? writable.first
                else { return reply(.failure(fail("No calendar can take new events."))) }
                event.calendar = target
                do {
                    try store.save(event, span: .thisEvent)
                    reply(.success(["id": event.eventIdentifier ?? ""]))
                } catch {
                    reply(.failure(fail("Couldn't save the event: \(error.localizedDescription)")))
                }
            default:
                reply(.failure(fail("Unknown calendar action \(action).")))
            }
        }
    }

    // MARK: Reminders

    private static func reminders(_ action: String, _ args: JSONObject, _ reply: @escaping (Result<Any, Error>) -> Void) {
        access(.reminder) { granted in
            guard granted else { return reply(.failure(denied("Reminders"))) }
            switch action {
            case "lists":
                reply(.success(["items": store.calendars(for: .reminder).map { ["name": $0.title] as JSONObject }]))
            case "list":
                var lists = store.calendars(for: .reminder)
                if let name = args["list"] as? String, !name.isEmpty {
                    lists = lists.filter { $0.title.caseInsensitiveCompare(name) == .orderedSame }
                }
                let includeDone = args["includeCompleted"] as? Bool ?? false
                let limit = args["limit"] as? Int ?? 50
                let predicate = includeDone
                    ? store.predicateForReminders(in: lists)
                    : store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: lists)
                store.fetchReminders(matching: predicate) { found in
                    let sorted = (found ?? []).sorted {
                        (due($0.dueDateComponents) ?? .distantFuture) < (due($1.dueDateComponents) ?? .distantFuture)
                    }
                    let items: [JSONObject] = sorted.prefix(limit).map {
                        [
                            "id": $0.calendarItemIdentifier,
                            "title": $0.title ?? "",
                            "dueMs": ms(due($0.dueDateComponents)),
                            "list": $0.calendar.title,
                            "completed": $0.isCompleted,
                        ]
                    }
                    DispatchQueue.main.async { reply(.success(["items": items])) }
                }
            case "create":
                let item = EKReminder(eventStore: store)
                item.title = args["title"] as? String ?? ""
                if let notes = args["notes"] as? String, !notes.isEmpty { item.notes = notes }
                let wanted = args["list"] as? String ?? ""
                let writable = store.calendars(for: .reminder).filter { $0.allowsContentModifications }
                guard let target = writable.first(where: { !wanted.isEmpty && $0.title.caseInsensitiveCompare(wanted) == .orderedSame })
                    ?? store.defaultCalendarForNewReminders() ?? writable.first
                else { return reply(.failure(fail("No Reminders list can take new items."))) }
                item.calendar = target
                if let due = date(args["dueMs"]) {
                    item.dueDateComponents = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: due)
                    item.addAlarm(EKAlarm(absoluteDate: due))
                }
                do {
                    try store.save(item, commit: true)
                    reply(.success(["id": item.calendarItemIdentifier]))
                } catch {
                    reply(.failure(fail("Couldn't save the reminder: \(error.localizedDescription)")))
                }
            case "complete":
                guard let id = args["id"] as? String, let item = store.calendarItem(withIdentifier: id) as? EKReminder else {
                    return reply(.failure(fail("No reminder with that id.")))
                }
                item.isCompleted = true
                do {
                    try store.save(item, commit: true)
                    reply(.success(["title": item.title ?? ""]))
                } catch {
                    reply(.failure(fail("Couldn't update the reminder: \(error.localizedDescription)")))
                }
            default:
                reply(.failure(fail("Unknown reminders action \(action).")))
            }
        }
    }

    // MARK: Mail

    /// Fields come back separated by control characters that never occur in mail headers.
    private static let fieldSeparator = "\u{1F}"
    private static let recordSeparator = "\u{1E}"

    private static func mail(_ action: String, _ args: JSONObject, _ reply: @escaping (Result<Any, Error>) -> Void) {
        switch action {
        case "recent":
            let limit = String(min(25, max(1, args["limit"] as? Int ?? 10)))
            let unread = (args["unreadOnly"] as? Bool ?? false) ? "1" : "0"
            let query = args["query"] as? String ?? ""
            runScript(MailScripts.recent, [limit, unread, query]) { result in
                switch result {
                case let .failure(error): reply(.failure(error))
                case let .success(output):
                    let items: [JSONObject] = output.components(separatedBy: recordSeparator).compactMap { line in
                        let f = line.components(separatedBy: fieldSeparator)
                        guard f.count >= 5 else { return nil }
                        return [
                            "id": f[0].trimmingCharacters(in: .whitespacesAndNewlines),
                            "sender": f[1],
                            "subject": f[2],
                            "dateMs": ms(Date(timeIntervalSinceNow: Double(f[3]) ?? 0)),
                            "read": f[4].trimmingCharacters(in: .whitespacesAndNewlines) == "true",
                        ]
                    }
                    reply(.success(["items": items]))
                }
            }
        case "read":
            runScript(MailScripts.read, [args["id"] as? String ?? ""]) { result in
                switch result {
                case let .failure(error): reply(.failure(error))
                case let .success(output):
                    let f = output.components(separatedBy: fieldSeparator)
                    guard f.count >= 5 else { return reply(.failure(fail("Mail didn't find that message."))) }
                    reply(.success([
                        "sender": f[0],
                        "to": f[1],
                        "subject": f[2],
                        "dateMs": ms(Date(timeIntervalSinceNow: Double(f[3]) ?? 0)),
                        "body": f[4...].joined(separator: fieldSeparator),
                    ] as JSONObject))
                }
            }
        case "draft":
            let to = (args["to"] as? [String] ?? []).joined(separator: ",")
            runScript(MailScripts.draft, [to, args["subject"] as? String ?? "", args["body"] as? String ?? ""]) { result in
                switch result {
                case let .failure(error): reply(.failure(error))
                case .success: reply(.success(["ok": true]))
                }
            }
        default:
            reply(.failure(fail("Unknown mail action \(action).")))
        }
    }

    // MARK: Notes

    private static func notes(_ action: String, _ args: JSONObject, _ reply: @escaping (Result<Any, Error>) -> Void) {
        switch action {
        case "create":
            let title = args["title"] as? String ?? ""
            let html = NotesScripts.html(title: title, body: args["body"] as? String ?? "")
            runScript(NotesScripts.create, [title, html], app: "Notes") { result in
                switch result {
                case let .failure(error): reply(.failure(error))
                case .success: reply(.success(["ok": true]))
                }
            }
        default:
            reply(.failure(fail("Unknown notes action \(action).")))
        }
    }

    /// Runs `osascript` with the script on stdin and the values as arguments, so nothing is pasted into the script text.
    private static func runScript(_ script: String, _ arguments: [String], app: String = "Mail", done: @escaping (Result<String, Error>) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
            process.arguments = ["-"] + arguments
            let input = Pipe(), output = Pipe(), errors = Pipe()
            process.standardInput = input
            process.standardOutput = output
            process.standardError = errors
            do {
                try process.run()
            } catch {
                return DispatchQueue.main.async { done(.failure(fail("Couldn't start \(app): \(error.localizedDescription)"))) }
            }
            input.fileHandleForWriting.write(Data(script.utf8))
            input.fileHandleForWriting.closeFile()
            let timer = DispatchWorkItem { if process.isRunning { process.terminate() } }
            DispatchQueue.global().asyncAfter(deadline: .now() + 45, execute: timer)
            let data = output.fileHandleForReading.readDataToEndOfFile()
            let problem = errors.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            timer.cancel()
            DispatchQueue.main.async {
                if process.terminationStatus == 0 {
                    done(.success(String(decoding: data, as: UTF8.self).trimmingCharacters(in: .newlines)))
                    return
                }
                let text = String(decoding: problem, as: UTF8.self)
                log.error("osascript failed: \(text, privacy: .private)")
                if text.contains("-1743") || text.localizedCaseInsensitiveContains("not allowed") {
                    done(.failure(fail("Murmur needs permission to control \(app). Allow it in System Settings > Privacy & Security > Automation, then try again.")))
                } else {
                    done(.failure(fail("\(app) couldn't do that.")))
                }
            }
        }
    }
}

/// AppleScript for Mail. Values arrive in `argv`; the output is plain text split by control characters.
enum MailScripts {
    static let recent = """
    on run argv
        set maxCount to (item 1 of argv) as integer
        set unreadOnly to (item 2 of argv) is "1"
        set needle to item 3 of argv
        set fs to character id 31
        set rs to character id 30
        set out to ""
        set found to 0
        set stamp to current date
        tell application "Mail"
            set total to count of messages of inbox
            if total > 200 then set total to 200
            repeat with i from 1 to total
                set m to message i of inbox
                set isRead to read status of m
                if not (unreadOnly and isRead) then
                    set subj to subject of m
                    set senderText to sender of m
                    if needle is "" or subj contains needle or senderText contains needle then
                        set out to out & (id of m) & fs & senderText & fs & subj & fs & ((date received of m) - stamp) & fs & isRead & rs
                        set found to found + 1
                        if found >= maxCount then exit repeat
                    end if
                end if
            end repeat
        end tell
        return out
    end run
    """

    static let read = """
    on run argv
        set fs to character id 31
        set stamp to current date
        tell application "Mail"
            set m to first message of inbox whose id is ((item 1 of argv) as integer)
            set toList to ""
            repeat with r in to recipients of m
                set toList to toList & (address of r) & ", "
            end repeat
            set bodyText to content of m
            if (length of bodyText) > 8000 then set bodyText to text 1 thru 8000 of bodyText
            return (sender of m) & fs & toList & fs & (subject of m) & fs & ((date received of m) - stamp) & fs & bodyText
        end tell
    end run
    """

    static let draft = """
    on run argv
        set addrList to item 1 of argv
        tell application "Mail"
            set m to make new outgoing message with properties {subject:(item 2 of argv), content:(item 3 of argv), visible:true}
            if addrList is not "" then
                set AppleScript's text item delimiters to ","
                repeat with a in text items of addrList
                    tell m to make new to recipient at end of to recipients with properties {address:(a as text)}
                end repeat
            end if
            activate
        end tell
        return "ok"
    end run
    """
}

/// AppleScript for Notes. Values arrive in `argv`; the body is HTML built by `html`, so the user's text is escaped.
enum NotesScripts {
    static let create = """
    on run argv
        tell application "Notes" to make new note with properties {name:(item 1 of argv), body:(item 2 of argv)}
        return "ok"
    end run
    """

    /// Notes stores HTML. The title becomes the first line, which Notes uses as the note's name.
    static func html(title: String, body: String) -> String {
        func escape(_ text: String) -> String {
            text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
        }
        let lines = body.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        let paragraphs = body.isEmpty ? "" : lines.map { $0.isEmpty ? "<div><br></div>" : "<div>\(escape($0))</div>" }.joined()
        return "<h1>\(escape(title))</h1>\(paragraphs)"
    }
}
