import AppKit
import AVFoundation
import ApplicationServices
import CoreGraphics

enum PermissionStatus {
    case granted, denied, unknown

    var key: String {
        switch self {
        case .granted: return "onboarding.status.granted"
        case .denied: return "onboarding.status.denied"
        case .unknown: return "onboarding.status.unknown"
        }
    }
}

/// Live permission checks and the matching System Settings panes.
enum Permissions {
    static var microphone: PermissionStatus {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return .granted
        case .denied, .restricted: return .denied
        default: return .unknown
        }
    }

    /// Accessibility (insertion, context) plus Input Monitoring (the hotkey tap).
    static var accessibility: PermissionStatus {
        AXIsProcessTrusted() && CGPreflightListenEventAccess() ? .granted : .unknown
    }

    static var screenRecording: PermissionStatus {
        CGPreflightScreenCaptureAccess() ? .granted : .unknown
    }

    static func requestMicrophone(_ done: @escaping (Bool) -> Void) {
        AVCaptureDevice.requestAccess(for: .audio) { granted in DispatchQueue.main.async { done(granted) } }
    }

    static func requestAccessibility() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
        _ = CGRequestListenEventAccess()
    }

    static func requestScreenRecording() {
        _ = CGRequestScreenCaptureAccess()
    }

    static func openSettings(_ pane: String) {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") {
            NSWorkspace.shared.open(url)
        }
    }
}
