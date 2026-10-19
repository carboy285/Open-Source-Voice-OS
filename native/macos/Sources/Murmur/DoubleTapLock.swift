import Foundation

/// Decides when two quick taps of the dictation key lock dictation on, so it keeps listening hands-free until the
/// key is pressed once more. Time is passed in, so the rules can be tested without a keyboard.
struct DoubleTapLock {
    /// A press shorter than this is a tap, not the start of a hold.
    static let tapLimit: TimeInterval = 0.3
    /// The second tap has to start within this long of the first one being let go.
    static let gap: TimeInterval = 0.4

    enum Press: Equatable {
        /// An ordinary press: start listening as usual.
        case start
        /// The second tap: start listening and keep going after the key is let go.
        case lock
        /// The press that ends a locked dictation.
        case stop
    }

    private var pressedAt: TimeInterval = 0
    private var tappedAt: TimeInterval?
    /// The release that follows the press that stopped a lock says nothing: the dictation already ended.
    private var swallowRelease = false
    private(set) var locked = false

    mutating func press(at now: TimeInterval, enabled: Bool) -> Press {
        if locked {
            locked = false
            tappedAt = nil
            swallowRelease = true
            return .stop
        }
        swallowRelease = false
        pressedAt = now
        if enabled, let tapped = tappedAt, now - tapped < Self.gap {
            tappedAt = nil
            locked = true
            return .lock
        }
        tappedAt = nil
        return .start
    }

    /// Returns whether the dictation should end now. A locked one carries on after the key is let go.
    mutating func release(at now: TimeInterval) -> Bool {
        if locked { return false }
        if swallowRelease {
            swallowRelease = false
            return false
        }
        tappedAt = now - pressedAt < Self.tapLimit ? now : nil
        return true
    }

    /// Forgets a lock, for example when the dictation was cancelled or never started.
    mutating func unlock() {
        locked = false
        tappedAt = nil
        swallowRelease = false
    }
}
