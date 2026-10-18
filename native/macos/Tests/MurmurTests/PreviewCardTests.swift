import XCTest
@testable import Murmur

final class PreviewCardTests: XCTestCase {
    func testReadsACardFromThePreview() {
        let rows: [JSONObject] = [
            ["icon": "clock", "style": "text", "values": ["Thursday · 2:00 – 2:30 PM"]],
            ["icon": "person", "style": "chips", "values": ["david@company.com"]],
            ["icon": "text", "style": "text", "values": [String]()],
        ]
        let badge: JSONObject = ["icon": "video", "text": "Google Meet"]
        let card: JSONObject = [
            "kind": "event", "icon": "calendar", "app": "Google Calendar", "title": "Design review with David",
            "rows": rows, "badge": badge,
        ]
        let json: JSONObject = [
            "callId": "1", "tool": "composio.googlecalendar_create_event", "displayName": "Google Calendar",
            "verb": "Save", "summary": "x", "card": card,
        ]
        let preview = Preview(json)
        XCTAssertEqual(preview?.card?.kind, "event")
        XCTAssertEqual(preview?.card?.title, "Design review with David")
        // A row with no values is dropped.
        XCTAssertEqual(preview?.card?.rows.count, 2)
        XCTAssertEqual(preview?.card?.rows.last?.style, "chips")
        XCTAssertEqual(preview?.card?.badgeText, "Google Meet")
    }

    func testAPreviewWithoutACardStillWorks() {
        let json: JSONObject = ["callId": "2", "summary": "Send email"]
        let preview = Preview(json)
        XCTAssertNotNil(preview)
        XCTAssertNil(preview?.card)
    }

    func testRowIconsMapToSymbols() {
        XCTAssertEqual(PreviewCard.symbol("clock"), "clock")
        XCTAssertEqual(PreviewCard.symbol("pin"), "mappin.and.ellipse")
        XCTAssertEqual(PreviewCard.symbol("something new"), "text.alignleft")
    }
}
