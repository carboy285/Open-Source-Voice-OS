import XCTest
@testable import Murmur

final class DoubleTapLockTests: XCTestCase {
    func testAHoldStartsAndStopsAsUsual() {
        var lock = DoubleTapLock()
        XCTAssertEqual(lock.press(at: 0, enabled: true), .start)
        XCTAssertTrue(lock.release(at: 2))
        XCTAssertFalse(lock.locked)
    }

    func testTwoQuickTapsLockAndAThirdPressStops() {
        var lock = DoubleTapLock()
        XCTAssertEqual(lock.press(at: 0, enabled: true), .start)
        XCTAssertTrue(lock.release(at: 0.1))
        XCTAssertEqual(lock.press(at: 0.25, enabled: true), .lock)
        XCTAssertTrue(lock.locked)
        // Letting go after the second tap keeps listening.
        XCTAssertFalse(lock.release(at: 0.35))
        XCTAssertTrue(lock.locked)
        XCTAssertEqual(lock.press(at: 5, enabled: true), .stop)
        XCTAssertFalse(lock.locked)
        XCTAssertFalse(lock.release(at: 5.1))
    }

    func testASlowSecondTapDoesNotLock() {
        var lock = DoubleTapLock()
        _ = lock.press(at: 0, enabled: true)
        _ = lock.release(at: 0.1)
        XCTAssertEqual(lock.press(at: 0.6, enabled: true), .start)
    }

    func testALongFirstPressIsNotATap() {
        var lock = DoubleTapLock()
        _ = lock.press(at: 0, enabled: true)
        _ = lock.release(at: 0.5)
        XCTAssertEqual(lock.press(at: 0.6, enabled: true), .start)
    }

    func testItDoesNothingWhenSwitchedOff() {
        var lock = DoubleTapLock()
        _ = lock.press(at: 0, enabled: false)
        _ = lock.release(at: 0.1)
        XCTAssertEqual(lock.press(at: 0.2, enabled: false), .start)
    }

    func testAThirdQuickTapAfterALockStopsInsteadOfLockingAgain() {
        var lock = DoubleTapLock()
        _ = lock.press(at: 0, enabled: true)
        _ = lock.release(at: 0.1)
        XCTAssertEqual(lock.press(at: 0.2, enabled: true), .lock)
        _ = lock.release(at: 0.25)
        XCTAssertEqual(lock.press(at: 0.4, enabled: true), .stop)
        _ = lock.release(at: 0.45)
        XCTAssertEqual(lock.press(at: 0.5, enabled: true), .start)
    }

    func testUnlockForgetsEverything() {
        var lock = DoubleTapLock()
        _ = lock.press(at: 0, enabled: true)
        _ = lock.release(at: 0.1)
        _ = lock.press(at: 0.2, enabled: true)
        lock.unlock()
        XCTAssertFalse(lock.locked)
        XCTAssertEqual(lock.press(at: 0.3, enabled: true), .start)
    }
}
