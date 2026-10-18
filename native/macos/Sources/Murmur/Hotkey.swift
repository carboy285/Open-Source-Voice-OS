import AppKit
import CoreGraphics

enum HotkeyAction {
    case dictate, agent, edit
}

/// Watches a modifier-only hotkey (Right Option by default) with a listen-only event tap.
/// Down fires on press, so the indicator can appear before the key is released.
final class HotkeyMonitor {
    /// kVK_RightOption. kVK_RightCommand is 54, kVK_Function is 63.
    var keyCode: Int64 = 61
    var onDown: ((HotkeyAction) -> Void)?
    var onUp: (() -> Void)?
    var onEscape: (() -> Void)?
    /// The notch focus shortcut, ⌃⌥A by default (`notch.md`). ⌃⌥Space is avoided: macOS uses it to switch input sources.
    var onFocusShortcut: (() -> Void)?
    /// kVK_ANSI_A, with Control and Option held.
    var focusKeyCode: Int64 = 0
    var focusModifiers: CGEventFlags = [.maskControl, .maskAlternate]

    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var isDown = false
    var toggleMode = false

    var isRunning: Bool { tap != nil }

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
            if code == 53, isDown || toggleMode { // Esc
                DispatchQueue.main.async { self.onEscape?() }
                isDown = false
            }
            return
        }
        guard type == .flagsChanged, code == keyCode else { return }
        let flags = event.flags
        let pressed = flags.contains(modifierFlag(for: keyCode))
        if pressed {
            let action: HotkeyAction = flags.contains(.maskShift) ? .agent : flags.contains(.maskCommand) ? .edit : .dictate
            if toggleMode {
                if isDown {
                    isDown = false
                    DispatchQueue.main.async { self.onUp?() }
                } else {
                    isDown = true
                    DispatchQueue.main.async { self.onDown?(action) }
                }
            } else if !isDown {
                isDown = true
                DispatchQueue.main.async { self.onDown?(action) }
            }
        } else if isDown, !toggleMode {
            isDown = false
            DispatchQueue.main.async { self.onUp?() }
        }
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
