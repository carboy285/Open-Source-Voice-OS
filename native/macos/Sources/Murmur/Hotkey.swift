import AppKit
import CoreGraphics

enum HotkeyAction {
    case dictate, agent, edit
    /// Hold the key with Control and drag to circle something on the screen. No microphone.
    case circle
}

/// Watches a modifier-only hotkey (Right Option by default) with a listen-only event tap.
/// Down fires on press, so the indicator can appear before the key is released.
final class HotkeyMonitor {
    /// kVK_RightOption. kVK_RightCommand is 54, kVK_Function is 63.
    var keyCode: Int64 = 61
    var onDown: ((HotkeyAction) -> Void)?
    var onUp: (() -> Void)?
    /// Shift or Command pressed after the hotkey went down: the hold switches to agent or edit.
    var onActionChange: ((HotkeyAction) -> Void)?
    var onEscape: (() -> Void)?
    /// The notch focus shortcut, ⌃⌥A by default (`notch.md`). ⌃⌥Space is avoided: macOS uses it to switch input sources.
    var onFocusShortcut: (() -> Void)?
    /// ⌃⌥T opens the typing box (kVK_ANSI_T, same modifiers). Typed Ask and Edit need no microphone.
    var onTypeShortcut: (() -> Void)?
    var typeKeyCode: Int64 = 17
    /// kVK_ANSI_A, with Control and Option held.
    var focusKeyCode: Int64 = 0
    var focusModifiers: CGEventFlags = [.maskControl, .maskAlternate]

    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var isDown = false
    private var action: HotkeyAction = .dictate
    var toggleMode = false
    /// Two quick taps lock dictation on until the key is pressed again.
    var doubleTapLock = true
    /// Fires on the main thread when a lock starts or ends, so the notch can say "press again to stop".
    var onLockChange: ((Bool) -> Void)?
    private var lock = DoubleTapLock()

    var isLocked: Bool { lock.locked }

    /// Drops a lock, for example when the dictation it belonged to ended or never began.
    func releaseLock() {
        guard lock.locked else { return }
        lock.unlock()
        isDown = false
        DispatchQueue.main.async { self.onLockChange?(false) }
    }

    private var now: TimeInterval { ProcessInfo.processInfo.systemUptime }

    var isRunning: Bool { tap != nil }

    /// Whether the hotkey's modifier is physically down right now, read from the system, not from tap events.
    var isPhysicallyHeld: Bool {
        CGEventSource.flagsState(.combinedSessionState).contains(modifierFlag(for: keyCode))
    }

    /// Forgets a hold whose release was never seen.
    func forceRelease() { isDown = false }
    /// False when macOS switched the tap off, e.g. after the Accessibility grant changed.
    var isEnabled: Bool { tap.map { CGEvent.tapIsEnabled(tap: $0) } ?? false }

    /// Needs Input Monitoring (listen-only taps). Returns false when the system refuses the tap.
    @discardableResult
    func start() -> Bool {
        guard tap == nil else { return true }
        let mask = CGEventMask(1 << CGEventType.flagsChanged.rawValue) | CGEventMask(1 << CGEventType.keyDown.rawValue)
        let callback: CGEventTapCallBack = { _, type, event, refcon in
            if let refcon {
                let monitor = Unmanaged<HotkeyMonitor>.fromOpaque(refcon).takeUnretainedValue()
                monitor.handle(type: type, event: event)
            }
            return Unmanaged.passUnretained(event)
        }
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: mask,
            callback: callback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else { return false }
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        self.tap = tap
        self.source = source
        return true
    }

    func stop() {
        if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        tap = nil
        source = nil
    }

    private func handle(type: CGEventType, event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return
        }
        let code = event.getIntegerValueField(.keyboardEventKeycode)
        if type == .keyDown {
            if code == focusKeyCode, isFocusShortcut(event.flags) {
                DispatchQueue.main.async { self.onFocusShortcut?() }
                return
            }
            if code == typeKeyCode, isFocusShortcut(event.flags) {
                DispatchQueue.main.async { self.onTypeShortcut?() }
                return
            }
            if code == 53, isDown || toggleMode || lock.locked { // Esc
                DispatchQueue.main.async { self.onEscape?() }
                isDown = false
                releaseLock()
            }
            return
        }
        guard type == .flagsChanged else { return }
        let flags = event.flags
        // People hold the hotkey first and add Shift or Command a moment later. The mode is upgraded
        // while the hold lasts and sticks, so letting go of Shift before the hotkey keeps agent mode.
        if code != keyCode {
            // A lock is a hold that no longer needs the finger, so Shift, Command or Control still switch its mode.
            if isDown || lock.locked, action == .dictate {
                let upgraded = Self.action(for: flags)
                if upgraded != .dictate {
                    action = upgraded
                    DispatchQueue.main.async { self.onActionChange?(upgraded) }
                }
            }
            return
        }
        let pressed = flags.contains(modifierFlag(for: keyCode))
        if pressed {
            let action = Self.action(for: flags)
            if toggleMode {
                if isDown {
                    isDown = false
                    DispatchQueue.main.async { self.onUp?() }
                } else {
                    isDown = true
                    self.action = action
                    DispatchQueue.main.async { self.onDown?(action) }
                }
            } else if !isDown {
                isDown = true
                self.action = action
                // Every hold works the same way: dictation, agent, edit and Circle to Ask can all be locked.
                switch lock.press(at: now, enabled: doubleTapLock) {
                case .start:
                    DispatchQueue.main.async { self.onDown?(action) }
                case .lock:
                    DispatchQueue.main.async {
                        self.onLockChange?(true)
                        self.onDown?(action)
                    }
                case .stop:
                    // The press that ends a locked dictation. The release after it does nothing.
                    isDown = false
                    DispatchQueue.main.async {
                        self.onLockChange?(false)
                        self.onUp?()
                    }
                }
            }
        } else if isDown, !toggleMode {
            isDown = false
            // A locked dictation keeps listening after the key is let go.
            if lock.release(at: now) { DispatchQueue.main.async { self.onUp?() } }
        }
    }

    private static func action(for flags: CGEventFlags) -> HotkeyAction {
        if flags.contains(.maskShift) { return .agent }
        if flags.contains(.maskCommand) { return .edit }
        if flags.contains(.maskControl) { return .circle }
        return .dictate
    }

    /// Exactly the focus modifiers: Command or Shift held as well means a different shortcut.
    private func isFocusShortcut(_ flags: CGEventFlags) -> Bool {
        let relevant: CGEventFlags = [.maskControl, .maskAlternate, .maskCommand, .maskShift]
        return flags.intersection(relevant) == focusModifiers
    }

    private func modifierFlag(for code: Int64) -> CGEventFlags {
        switch code {
        case 54, 55: return .maskCommand
        case 59, 62: return .maskControl
        case 56, 60: return .maskShift
        case 63: return .maskSecondaryFn
        default: return .maskAlternate
        }
    }

    /// Human-readable name for menus and onboarding.
    static func name(for code: Int64) -> String {
        switch code {
        case 61: return "Right Option"
        case 58: return "Left Option"
        case 54: return "Right Command"
        case 62: return "Right Control"
        case 63: return "Fn"
        default: return "Key \(code)"
        }
    }
}
