import Foundation

/// The decisions behind text insertion, kept free of system calls so they can be tested.
enum InsertPlan {
    enum Route: String {
        case accessibility, paste, typing
    }

    /// What can be read from the focused element: its text and where the caret is.
    struct Snapshot: Equatable {
        var value: String?
        var caret: Int?
    }

    static let maxTypedLength = 2000

    /// The routes worth trying, in order. Posting keystrokes needs both Accessibility and the post-events grant.
    static func routes(trusted: Bool, canPost: Bool, axSettable: Bool, length: Int) -> [Route] {
        var routes: [Route] = []
        if axSettable { routes.append(.accessibility) }
        if trusted, canPost {
            routes.append(.paste)
            if length <= maxTypedLength { routes.append(.typing) }
        }
        return routes
    }

    /// Whether the focused element changed after an insert. `nil` means nothing could be read to compare.
    static func changed(before: Snapshot, after: Snapshot) -> Bool? {
        if before.value != nil, after.value != nil { return before.value != after.value }
        if before.caret != nil, after.caret != nil { return before.caret != after.caret }
        return nil
    }

    /// Why nothing was placed, for the log and the shell.
    static func failureReason(trusted: Bool, canPost: Bool) -> String {
        if !trusted { return "no_accessibility" }
        if !canPost { return "no_post_permission" }
        return "not_inserted"
    }
}
