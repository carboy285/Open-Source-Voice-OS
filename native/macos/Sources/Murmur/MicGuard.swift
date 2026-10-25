import Foundation

/// Decides when an open microphone has lost its owner, so it can be closed instead of staying on unseen.
enum MicGuard {
    enum Problem: Equatable {
        /// The state moved away from listening (a late core event) while the mic kept recording.
        case stateLost
        /// Still listening, but the hotkey is physically up: the release was never seen.
        case releaseLost
    }

    static func problem(
        recording: Bool, state: ShellState, toggleMode: Bool, tapRunning: Bool, keyHeld: Bool, locked: Bool = false
    ) -> Problem? {
        guard recording else { return nil }
        // The short tail after a release is expected: the mic stays open while the state is already "transcribing".
        if state == .transcribing { return nil }
        if state != .listening { return .stateLost }
        // Toggle mode and a double-tap lock both keep recording without the key held. That is not a lost release.
        if !toggleMode, !locked, tapRunning, !keyHeld { return .releaseLost }
        return nil
    }
}
