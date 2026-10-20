import AppKit
import ApplicationServices

enum RecentInsertion {
    private static var element: AXUIElement?
    private static var value = ""
    private static var caret = 0
    private static var text = ""

    private static func selectedRange(_ element: AXUIElement) -> CFRange? {
        guard let raw = AX.attribute(element, kAXSelectedTextRangeAttribute), CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
        var range = CFRange()
        return AXValueGetValue(raw as! AXValue, .cfRange, &range) ? range : nil
    }

    static func remember(_ inserted: String, ok: Bool) {
        element = nil
        guard ok, !inserted.isEmpty, let focused = AX.focusedElement(), !AX.isSecure(focused),
              let content = AX.string(focused, kAXValueAttribute), let range = selectedRange(focused), range.length == 0,
              range.location >= inserted.utf16.count, range.location <= content.utf16.count else { return }
        let span = NSRange(location: range.location - inserted.utf16.count, length: inserted.utf16.count)
        guard (content as NSString).substring(with: span) == inserted else { return }
        element = focused; value = content; caret = range.location; text = inserted
    }

    static func replace(expected: String, with replacement: String) -> Bool {
        guard expected == text, let saved = element, let focused = AX.focusedElement(), CFEqual(saved, focused), !AX.isSecure(focused),
              AX.string(focused, kAXValueAttribute) == value, let current = selectedRange(focused), current.location == caret, current.length == 0 else { return false }
        var range = CFRange(location: caret - expected.utf16.count, length: expected.utf16.count)
        guard let axRange = AXValueCreate(.cfRange, &range),
              AXUIElementSetAttributeValue(focused, kAXSelectedTextRangeAttribute as CFString, axRange) == .success else { return false }
        let result = TextInserter.insert(replacement)
        remember(replacement, ok: result.ok)
        return result.ok
    }
}
