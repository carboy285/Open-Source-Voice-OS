# Local Mac update — 0.2.8.6.3

This checkout starts from the installed Murmur version 0.2.8.6.2 (local commit b1d0063). It contains local changes only. No commits, tags, pushes, GitHub release, or installer publication were made.

Changes:

- Captures the app, focused window, field contents and selection at the start of dictation/editing. Guarded insertions stop if they change; output remains in Tasks & results.
- Previews voice edits with Replace selection / Keep original, and rechecks the original target after approval.
- Adds Verbatim, Clean up and Polished modes in Settings → Dictation. The existing dictionary applies in all three modes.
- Cancels transcription/model processing and suppresses late insertions after Escape. Escape or Cancel also cancels the most recent active agent task. An action already dispatched to an external tool may still finish.
- Adds memory-only dictation/edit recovery with Copy, Reinsert and Retry. Reinsert/Retry waits until you focus a destination and press/release the normal dictation key. Select the desired text first when retrying an edit. Only the latest result is kept by default; session history can keep 20 results. Existing Privacy transcript storage remains separate.
- Expands Tasks & results with full agent replies and a follow-up field, using Murmur's existing conversation and approval system.
- Adds optional persistent Whisper via a locally installed whisper-server (resolved from the bundled bin directory, Homebrew or PATH). Uses WAV audio held in memory, a random loopback port and route, and shuts down on cancellation/quit. Parakeet and hosted speech retain their existing backends.
- Moves Keychain RPC reads/writes off the UI thread so macOS authorization cannot freeze Murmur.
- Opens Tasks & results as a standard window in the local build.
- Keeps onboarding unchanged. Local build metadata pauses automatic GitHub update checks without changing the saved update preference.

Build locally with the installed runtime, speech engines and assets as the resource donor:

```sh
MURMUR_SDK=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk scripts/package-local-macos.sh
```

The SDK override works around missing SwiftUI compiler plugins in this Mac's newer SDK. Output: build/local/Murmur.app. The script never fetches, tags, pushes or publishes.

Original app backup: /Users/ben/src/Murmur-0.2.8.6.2-before-local-update.app.bak
Database backup: build/backups/murmur-before-local-update.db (private permissions)

Validation: TypeScript typecheck; 327 passing core tests (2 existing tests skipped); production Swift build; bundle signature validation; bundled-core smoke check. Native XCTest execution is unavailable with the installed command-line tools because XCTest is missing. Installed-app launch and UI checks are performed separately.

Settings, Keychain entries, downloaded speech models and the database remain outside the app bundle. Ad-hoc builds may require renewing macOS Accessibility/Input Monitoring permission after replacement.
