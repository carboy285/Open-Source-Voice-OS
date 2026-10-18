import XCTest
@testable import Murmur

final class InsertPlanTests: XCTestCase {
    func testRoutesNeedPostPermissionForKeystrokes() {
        XCTAssertEqual(InsertPlan.routes(trusted: true, canPost: true, axSettable: true, length: 10), [.accessibility, .paste, .typing])
        XCTAssertEqual(InsertPlan.routes(trusted: true, canPost: false, axSettable: false, length: 10), [])
        XCTAssertEqual(InsertPlan.routes(trusted: false, canPost: true, axSettable: true, length: 10), [.accessibility])
    }

    func testLongTextIsNotTyped() {
        XCTAssertEqual(InsertPlan.routes(trusted: true, canPost: true, axSettable: false, length: 5000), [.paste])
    }

    func testChangeDetection() {
        let before = InsertPlan.Snapshot(value: "abc", caret: 3)
        XCTAssertEqual(InsertPlan.changed(before: before, after: .init(value: "abcdef", caret: 6)), true)
        XCTAssertEqual(InsertPlan.changed(before: before, after: before), false)
        XCTAssertEqual(InsertPlan.changed(before: .init(value: nil, caret: 3), after: .init(value: nil, caret: 9)), true)
        XCTAssertNil(InsertPlan.changed(before: .init(), after: .init()))
    }

    func testFailureReasons() {
        XCTAssertEqual(InsertPlan.failureReason(trusted: false, canPost: true), "no_accessibility")
        XCTAssertEqual(InsertPlan.failureReason(trusted: true, canPost: false), "no_post_permission")
        XCTAssertEqual(InsertPlan.failureReason(trusted: true, canPost: true), "not_inserted")
    }
}
