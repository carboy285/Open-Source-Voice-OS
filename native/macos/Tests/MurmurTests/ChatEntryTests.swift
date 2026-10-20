import XCTest
@testable import Murmur

final class ChatEntryTests: XCTestCase {
    func testAnEntryReadsWhatTheCoreSends() {
        let entry = ChatEntry([
            "id": 3,
            "request": "what's on my calendar",
            "reply": "Nothing today.",
            "status": "done",
            "actions": [["tool": "apple_calendar.events", "summary": "List events", "isError": false]],
        ])
        XCTAssertEqual(entry?.id, 3)
        XCTAssertEqual(entry?.request, "what's on my calendar")
        XCTAssertEqual(entry?.reply, "Nothing today.")
        XCTAssertEqual(entry?.status, "done")
        XCTAssertEqual(entry?.actions.map(\.summary), ["List events"])
        XCTAssertEqual(entry?.actions.map(\.failed), [false])
    }

    func testAFailedActionAndMissingFieldsAreHandled() {
        let entry = ChatEntry(["id": 4, "status": "failed", "actions": [["tool": "files.read", "isError": true]]])
        XCTAssertEqual(entry?.request, "")
        XCTAssertEqual(entry?.status, "failed")
        // With no summary the tool's name stands in.
        XCTAssertEqual(entry?.actions.first?.summary, "files.read")
        XCTAssertEqual(entry?.actions.first?.failed, true)
    }

    func testAnEntryWithoutAnIdIsDropped() {
        XCTAssertNil(ChatEntry(["request": "hi"]))
    }
}
