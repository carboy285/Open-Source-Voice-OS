# Platform

## Shape (D)

- A cross-platform **core** (headless process) holds the pipelines, agent, connectors, MCP client, storage and i18n.
- A thin native **shell** per OS owns everything OS-specific: tray/menu-bar UI (B-X1), global hotkeys (B-X2), audio capture, text insertion, accessibility/screen context, notifications, keychain, permission onboarding (B-X3), side panel and approval windows.
- The shell starts the core as a child process and talks to it over stdio.

## Core ↔ shell protocol (D)

Newline-delimited JSON-RPC 2.0. Both sides can send requests and notifications.

| Direction | Method | Purpose |
|-----------|--------|---------|
| shell → core | `dictation.start` / `dictation.stop {audio: base64 PCM16 mono 16 kHz}` / `dictation.cancel` | push-to-talk |
| shell → core | `agent.run {transcript or audio, context}` | start a task |
| shell → core | `approval.respond {callId, decision: approve/cancel, input?}` | gate result |
| shell → core | `task.cancel {taskId}`, `task.list`, `settings.get/set`, `dictionary.*` | UI |
| core → shell | `text.insert {text}` → `{ok, method}` | insertion |
| core → shell | `context.capture` → `{appId, appName, windowTitle, role, selection, underPointer, focusedText}` | context |
| core → shell | `approval.request {preview}` (notification; reply arrives as `approval.respond`) | gate |
| core → shell | `task.update {taskId, status, steps}`, `notify {title, body}` | side panel |
| core → shell | `secret.get/set/delete {key}` | keychain |
| core → shell | `dictation.result {text, changes}` | change report |

## Hotkeys (D)

| Action | macOS default | Windows default |
|--------|---------------|-----------------|
| Dictate (hold) | Right Option (Fn optional) | Right Alt |
| Agent (hold) | Right Option + Shift | Right Alt + Shift |
| Voice edit (hold, with selection) | Right Option + Cmd | Right Alt + Ctrl |
| Cancel | Esc while listening | Esc while listening |

All can be remapped. A modifier-only hotkey is detected with a low-level event tap/hook.

## Permission onboarding (B-X3)

A first-run flow in this order, each step explaining why in Murmur's own words, with "Open Settings" and a live status check:

| Permission | macOS | Windows | Required for |
|------------|-------|---------|--------------|
| Microphone | AVCaptureDevice authorization | Privacy › Microphone | dictation, agent |
| Accessibility | AX trusted-process check | not needed (UI Automation works unprivileged; elevated windows can't be reached and show a notice) | insertion, context |
| Screen recording | ScreenCaptureKit authorization | not needed (Graphics Capture shows a system border) | optional visual context |
| Automation (Apple Events) | per target app, only when a connector needs it | — | optional |

The app works with only the microphone; missing permissions degrade features with a clear notice.

## i18n (B-X4)

- UI languages: English and Japanese. All strings live in per-locale catalogs with identical keys. The locale follows the OS, overridable in Settings (D).
- All copy is written new for Murmur (LEGAL.md).

## Updates (D)

Releases are published on GitHub with a `SHA256SUMS.txt` listing every installer.

- macOS: Murmur checks the latest release 20 s after launch and every 6 h (setting, on by default). A newer version shows in the menu and Settings, with a one-time notification. "Install and Restart" downloads the `-macos-universal.dmg`, verifies it against `SHA256SUMS.txt`, mounts it, checks the app's bundle id, version and code signature, replaces the installed app and relaunches. Without a checksum, or when the app's folder isn't writable, it doesn't install: in the second case it opens the disk image for a manual drag.
- Windows: not yet; download the new installer from the release page.
- Ad-hoc signed builds change code identity on every release, so macOS asks for Accessibility and Input Monitoring again after an update. A Developer ID signature avoids this.
