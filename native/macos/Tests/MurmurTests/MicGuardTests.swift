import XCTest
@testable import Murmur

final class MicGuardTests: XCTestCase {
    private func problem(_ recording: Bool, _ state: ShellState, toggle: Bool = false, running: Bool = true, held: Bool = true) -> MicGuard.Problem? {
        MicGuard.problem(recording: recording, state: state, toggleMode: toggle, tapRunning: running, keyHeld: held)
    }

    func testNothingOpenIsFine() {
        XCTAssertNil(problem(false, .idle))
        XCTAssertNil(problem(false, .done))
    }

    func testNormalHoldIsFine() {
        XCTAssertNil(problem(true, .listening))
    }

    func testReleaseTailIsFine() {
        XCTAssertNil(problem(true, .transcribing, held: false))
    }

    func testLateCoreStateWhileRecording() {
        XCTAssertEqual(problem(true, .done), .stateLost)
        XCTAssertEqual(problem(true, .idle), .stateLost)
        XCTAssertEqual(problem(true, .error), .stateLost)
    }

    func testLostReleaseWhenKeyIsUp() {
        XCTAssertEqual(problem(true, .listening, held: false), .releaseLost)
    }

    func testToggleModeAndDeadTapAreNotTreatedAsLostRelease() {
        XCTAssertNil(problem(true, .listening, toggle: true, held: false))
        XCTAssertNil(problem(true, .listening, running: false, held: false))
    }
}
