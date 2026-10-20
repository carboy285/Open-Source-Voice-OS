# Murmur

Murmur is a voice layer for macOS and Windows: hold a key, speak, and cleaned-up text appears in whatever app you are using. Hold a second key to ask for something instead (or press ⌃⌥T and type it; replies can be read aloud, and follow-ups remember the conversation). On a Mac, hold Right Option + Control and drag around anything on screen to ask about it, with a picture and the text read from it, and Murmur carries it out through connectors and MCP servers, showing you a preview before anything is sent, booked or changed.

## Requirements

- macOS 13.3 or later (Apple silicon or Intel), or Windows 10 1809 or later (x64)
- A speech model, downloaded from inside the app: NVIDIA Parakeet TDT 0.6B v3 (about 680 MB for the recommended size). It's saved in `~/Library/Application Support/Murmur/models` and runs on your Mac through whisper.cpp's `parakeet-cli`, which ships inside Murmur.app. Parakeet covers English and 24 other European languages. For Japanese, switch the engine to whisper.cpp in Settings › Dictation and choose a whisper model file.
- For the agent: sign in with your ChatGPT subscription (a code you enter on OpenAI's page, no API key), an Anthropic API key, or any server with an OpenAI-compatible `/v1/chat/completions` endpoint (a local model server works)
- For apps: a free [Composio](https://composio.dev) API key lets the agent use Gmail, Google Calendar, Slack, Notion and many more (Settings › Apps). On a Mac it can also read Mail and use Calendar and Reminders directly (Settings › Connectors).
- To build from source: Node.js 22, plus Xcode 15 or later on macOS, or the .NET 8 SDK on Windows

## Install

Download the latest installer from the [Releases page](https://github.com/carboy285/open-source-voice-os/releases):

- macOS: `Murmur-<version>-macos-universal.dmg`. Open it and drag Murmur to Applications.
- Windows: `Murmur-<version>-windows-x64-setup.exe`. It installs to Program Files and adds a Start menu entry. You can choose to start Murmur at sign-in and to add the `murmur` command to PATH.

Both installers include the Murmur engine and its Node.js runtime, so you don't need Node installed.

### Updates

On macOS, Murmur checks for a new release shortly after launch and every 6 hours. When one is out, the menu shows "Install Murmur x.y.z and Restart": Murmur downloads the disk image, checks it against the release's SHA-256 checksum, replaces itself and reopens. You can turn automatic checks off in Settings › General and still check by hand. On Windows, download the new installer from the Releases page.

To publish a release, set the version in `package.json`, commit, and push a matching tag (`git tag v0.2.1 && git push origin v0.2.1`). The release workflow builds both installers, writes `SHA256SUMS.txt` and creates the GitHub Release.

### Unsigned builds

Release builds are signed only when the project's signing certificates are configured. Builds from CI artifacts or from your own machine are unsigned.

- macOS: the first time, right-click Murmur in Applications and choose Open, then Open again. If macOS still blocks it, go to System Settings › Privacy & Security and click Open Anyway.
- Windows: SmartScreen may say "Windows protected your PC". Click More info, then Run anyway.

### Build from source

Clone the repository and build the engine first:

```sh
npm ci
npm test
npm run bundle:core      # writes build/core/murmur-core.mjs
```

macOS app and disk image:

```sh
cd native/macos && swift build          # debug build of the menu-bar app
cd ../.. && scripts/package-macos.sh    # universal Murmur.app and build/installers/*.dmg
```

To run the debug build against your checkout, point it at the engine:
`MURMUR_CORE=$PWD/build/core/murmur-core.mjs MURMUR_NODE=$(which node) native/macos/.build/debug/Murmur`.
Without an app bundle and its Info.plist, macOS cannot ask for microphone access, so use `package-macos.sh` for everyday use.

Windows app and installer (PowerShell):

```powershell
dotnet build native/windows/Murmur.sln     # the tray app
./scripts/package-windows.ps1              # build/installers/*-setup.exe (needs Inno Setup 6)
```

## Quick start

1. Open Murmur. The first-run window asks for the microphone, and on macOS for Accessibility (to type into apps and to see the hotkey).
2. Download the speech model when the first-run window offers it, or later in Settings › Dictation. `murmur models download parakeet-tdt-0.6b-v3-q8_0` does the same from Terminal.
3. Click into any text field, hold Right Option (macOS) or Right Alt (Windows), speak, and let go. A small card shows what changed: fillers removed, spellings fixed, dictionary words applied.
4. To use the agent, add a model in Settings › Agent. Then hold the same key with Shift and say something like "remind me to call Ana at 3". Murmur shows a preview with Edit, Cancel and the action button. Nothing runs until you press it.
5. Hold the key with Command (macOS) or Ctrl (Windows) while text is selected to rewrite the selection by voice.

Add an MCP server from a terminal:

```sh
murmur add mcp notes -- npx -y @example/notes-mcp-server
murmur add mcp tracker --url https://mcp.example.com/mcp --header "Authorization=Bearer <token>"
murmur list mcp
murmur remove mcp notes
```

Tokens and keys passed with `--env` or `--header` are moved into the system keychain; the config file keeps only a reference. On macOS the command lives at `/Applications/Murmur.app/Contents/Resources/core/murmur` (link it into your PATH). On Windows, tick "Add the murmur command to PATH" in the installer.

You can also try the engine without a native app:

```sh
npx tsx src/cli/main.ts clean "um so first ship the beta second fix the login bug"
npx tsx src/cli/main.ts dictate --text "um hello there"
printf 'um hello there' | npx tsx src/cli/main.ts dictate --stdin
printf 'what reminders do I have' | npx tsx src/cli/main.ts agent --stdin
```

`dictate` and `agent` require exactly one input source: `--text <text>` (or just the quoted text), `--audio <file.wav>`, or `--stdin`.
`--stdin` reads piped text and rejects empty input; in an interactive terminal, use `--text` instead.
Audio input must be an existing mono 16 kHz PCM16 WAV file; Murmur reads it in memory and uses your configured
local speech engine. Dictation uses your existing personal dictionary and dictation settings. Agent requests use
your configured model and the usual approval gate; actions needing approval are cancelled without an interactive
terminal. The `clean "<text>"` command remains available for a quick cleanup and change report.

## Personalize your voice tools

Open Settings › Personalize to save voice shortcuts, choose a writing profile, or translate dictation into another language. Settings › Dictation controls the local live preview. Say “change Tuesday to Thursday” or “undo my last dictation” within two minutes to correct the last inserted passage while the cursor is still in place.

First-run setup now includes a guided introduction, permission checks, model setup and a practice area. See [Voice tools and guided setup](docs/PERSONALIZATION.md) for usage, limits and acceptance checks.

## Privacy

- Audio stays in memory and is never written to disk, locally or anywhere else.
- Transcripts are kept on your device only if you turn on Settings › Privacy › Keep transcripts. It is off by default.
- Murmur has no servers. The only network calls go to providers you configure (your model API, your search provider, services you connect).
- Keys and tokens live in macOS Keychain or Windows Credential Manager, never in files or the database.
- Anything that sends, books, changes or deletes something waits for your approval in a preview built by Murmur, not by the model.
- Settings › Privacy › Delete all Murmur data removes the database, saved keys and the MCP config.

Details are in [docs/PRIVACY.md](docs/PRIVACY.md).

## Architecture

- **Core** (`src/`, TypeScript on Node 22): dictation cleanup, the agent loop and approval gate, connectors, the MCP client, reminders, SQLite storage and the English and Japanese UI strings. It runs headless.
- **Shells** (`native/macos` in Swift and SwiftUI, `native/windows` in C# and WPF): hotkeys, microphone, text insertion, screen context, keychain, notifications and every window.
- **Protocol**: the shell starts the core (`murmur daemon`) and both sides talk newline-delimited JSON-RPC 2.0 over stdio. The method table is in `src/rpc/daemon.ts` and `docs/spec/platform.md`.

Behavior is specified in [docs/spec](docs/spec). To write a connector, see [docs/CONNECTORS.md](docs/CONNECTORS.md). To contribute, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Disclaimer

Murmur is an independent open-source project. It is not affiliated with, endorsed by or connected to WakoAI, Inc. or its VoiceOS product.
