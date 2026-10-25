# Open Source Voice OS

An open-source voice layer for your computer, in the spirit of tools like VoiceOS: dictate into any app, rewrite
selected text by voice, and hand tasks to an agent that uses MCP tools (including [REA](https://github.com/morluto/rea)
for reverse engineering). Written from public product descriptions only; it contains no code from any commercial app.

> **Status: early.** The engine, CLI and the macOS menu-bar app are written, typechecked and unit-tested. The
> macOS results panel has been smoke-tested in Electron on a Mac. Live microphone capture, permissions, and
> insertion across real apps still need end-to-end validation. Expect first-run problems and please report them.
> Not built yet: the screen-pointing overlay and Windows/Linux shells.

## Use your ChatGPT / Codex plan

The default model backend is your own [Codex CLI](https://github.com/openai/codex). You sign in once with ChatGPT and
Voice OS runs every model call through Codex. Voice OS never reads, copies or stores your Codex credentials.

```bash
npm install -g @openai/codex   # once
npm install && npm run build
node dist/cli/main.js login    # opens "codex login" (Sign in with ChatGPT)
node dist/cli/main.js status
```

To use Claude instead: `VOICEOS_LLM=anthropic ANTHROPIC_API_KEY=... voiceos ...`.

Each model call starts a fresh, ephemeral, read-only Codex run with your Codex config ignored, and Codex is told to
answer only with JSON. Tool use is handled by Voice OS itself, not by Codex, so the confirmation rules below always apply.
Calls take a few seconds because each one starts a Codex process; they time out after 120 seconds.

## macOS app

A menu-bar app (Electron). Opening the app from Applications also opens Results & settings. Hold a key, speak, release:

| Hold        | Does                                                     |
| ----------- | -------------------------------------------------------- |
| Right ⌥     | Dictate: cleaned-up text is typed into the focused app   |
| Right ⌘     | Edit: rewrites the selected text from your spoken request |
| Right ⌃     | Agent: runs your request with MCP tools (REA etc.)       |

If another key is pressed while a hotkey is held (for example ⌘C), the recording is cancelled. A tap shorter than
0.3 s is ignored. Status appears in a notch-style overlay at the top of the screen. When an agent request finishes or fails, the
notch opens on the display your pointer is on with the reply (basic markdown is rendered) and a "What I did" list of
the tools it ran. It stays open while your pointer is on it; use **×**, **Open in Results**, or **Escape** to close it.
It plays a soft system sound when it opens; set `"notchSound": false` in the settings file to turn that off. Press
**Escape** to cancel recording or processing.

```bash
brew install whisper-cpp          # local speech-to-text
npm install -g @openai/codex      # model access with your ChatGPT plan
npm install && npm run app        # builds and launches
```

Then, from the menu-bar item: **Sign in with ChatGPT (Codex)…**, and **Open settings file…** to set `whisperModel`
to a downloaded ggml model (and `mcpConfig` to give the agent tools). Settings live in
`~/Library/Application Support/Open Source Voice OS/config.json`.

Voice OS needs three macOS permissions: **Microphone** (requested when you first record), **Accessibility** (to inspect focus and selections and paste text) and
**Input Monitoring** (to see the hold-to-talk keys). Grant them in System Settings → Privacy & Security, then restart
the app. Text is inserted by putting it on the clipboard and pressing ⌘V; your previous text clipboard is restored.
The app checks the original app, window, focused control, and available field contents before insertion. If the
destination changes or cannot be identified through Accessibility, output is kept in Results instead of pasted.
These checks depend on the target app’s Accessibility support; focus changes during the final OS paste cannot be atomic.
Recordings are written to a temporary file for Whisper and deleted right after.

For a local macOS app bundle, run `npm run app:pack`. It creates an ad-hoc-signed app in
`release/mac-arm64/` (or the folder for your Mac’s architecture). Move **Open Source Voice OS.app** to Applications
and open it normally; Terminal is not needed to run the installed app. To update a local installation, quit it,
rebuild the bundle and replace the copy in Applications. Your settings live outside the app bundle and are retained.

`npm run app:dist` builds a `.dmg`; Developer ID signing and notarization need your Apple developer credentials.

## Results, editing, and recovery

Open **Results & settings…** from the menu bar. This window keeps full agent replies, a bounded activity log,
inline tool approvals, and a follow-up field. Agent follow-ups send the latest completed request and reply along
with the new request; failed or cancelled actions are never automatically retried.

Voice edits capture the selection when recording begins and show the original and proposed text before replacement.
**Replace selection** returns focus to the original app, then checks that the destination and selection still match.
**Keep original** retains the proposed edit without changing your document. Editors must expose selected text through
macOS Accessibility for voice editing.

Each result has **Copy**, **Reinsert…**, and (for dictation/edits) **Retry…** controls:

- Reinsert hides the panel. Focus your destination, then press and release the dictation hotkey to paste the saved output.
- Retry hides the panel. Focus the destination (and select text for an edit), then press and release the corresponding hotkey.
  It reprocesses the saved transcript without recording again.
- Escape cancels a queued recovery action or the current request. Cancellation stops later agent steps; a tool action already
  dispatched may still finish. CLI transcription and model subprocesses are terminated on cancellation. Persistent Whisper
  is stopped and restarted on the next recording.

History is optional and **off by default**: only the latest result remains available for recovery. Enable session history
in the panel to keep up to 100 results (20 by default). **Clear results** erases them immediately. History is held in memory
and discarded on quit; audio files are deleted after transcription. Editing, polished dictation, and agent requests still
send their relevant text to the configured model provider.

## Cleanup modes and vocabulary

Use **Dictation & history settings** in the results panel to switch modes without restarting:

- **Verbatim** preserves the recognized wording, repetitions, casing, and punctuation.
- **Clean up** removes fillers and stutters and adjusts capitalization and punctuation, without a model call.
- **Polished** also asks the configured model to refine the text.

Vocabulary maps recognized phrases to preferred spellings, for example `open ai = OpenAI`. Matching is literal,
case-insensitive, and on word boundaries; longer phrases take precedence. Vocabulary applies in every mode;
saved snippets remain verbatim. The settings file equivalents are:

```json
{
  "cleanupMode": "clean",
  "vocabulary": { "open ai": "OpenAI", "ben smith": "Ben Smyth" },
  "historyEnabled": false,
  "historyLimit": 20,
  "whisperBackend": "cli"
}
```

`cleanupMode` takes precedence over the older `polishDictation` setting. Other settings-file changes still require
restarting the app; settings saved through the panel take effect immediately.

For faster repeated dictation, select **Persistent Whisper server**. Install `whisper-server` from
[whisper.cpp](https://github.com/ggml-org/whisper.cpp/blob/master/examples/server/README.md), then configure
`whisperModel` as usual. The first transcription starts an app-owned server on a random loopback port with a
random route; subsequent recordings reuse the loaded model. It shuts down on quit or cancellation. The app
uses its WAV input directly, without ffmpeg conversion. If the binary is outside your PATH, set
`whisperServerBinary`. CLI mode remains the default and both backends time out after 120 seconds.

## Snippets and voice commands

Before an utterance goes to the model, Voice OS checks whether it is a saved snippet or a built-in command. Matching
is on the whole utterance, ignoring filler words, case, extra spacing and trailing punctuation, so
"Um, Scratch that." and "scratch that" are the same thing.

| Say | Does |
| --- | --- |
| "scratch that" or "undo that" | Undo the last thing Voice OS inserted (⌘Z in the focused app) |
| "select all" | Select everything in the focused app (⌘A) |
| a snippet's trigger, or "insert <trigger>" | Type the snippet's text verbatim |

Add snippets to the settings file (`~/Library/Application Support/Open Source Voice OS/config.json`):

```json
{
  "snippets": {
    "my address": "1 Infinite Loop\nCupertino, CA",
    "sign off": "Best,\nSam"
  }
}
```

Snippets are inserted exactly as written: no filler removal, no punctuation fix-up, no `polishDictation` pass. That
makes them useful for addresses, sign-offs and boilerplate. Because matching is whole-utterance only,
"select all the rows and delete them" is dictated normally rather than executed. Set `"voiceCommands": false` to
treat the built-in command phrases as ordinary dictation too. Commands send keystrokes, so they need Accessibility
permission. "Scratch that" is enabled only after a Voice OS insertion in the same destination, and is invalidated
by intervening keyboard input, clicks, scrolling, or another voice command. It still uses the target app’s ⌘Z
behavior, so app-driven changes can affect its undo stack.

## Built-in agent tools

The agent works out of the box, without any MCP setup. These tools are built in (turn them off with
`"builtinTools": false`):

| Tool | What it does | Asks first? |
|------|--------------|-------------|
| `get_datetime`, `search_files` | Current local time; find files by name with Spotlight | No |
| `create_reminder`, `create_event`, `create_note` | Reminders, Calendar and Notes | Yes |
| `draft_email` | Opens a Mail draft. It is never sent for you. | Yes |
| `send_message` | Sends an iMessage | Yes |
| `open_app`, `open_url`, `web_search` | Open an app, an http(s) link, or a browser search | Yes |
| `clipboard_read`, `clipboard_write` | Read or replace the clipboard | Yes |

Anything that changes something, or reveals private data such as the clipboard, shows an approval card first. Your
words reach AppleScript as arguments, never as script text. MCP tools are added alongside these.

## Language, context and history

- **Language.** `"language": "es"` (any Whisper code) pins the speech language; the default `"auto"` detects it.
- **Context from the focused field.** Off by default. With `"screenContext": true`, the app type and the end of the
  text you are writing in (never a password field, no screenshot) go to your model for polished dictation, edits and
  the agent, so replies match what you are writing. The agent also always gets the current date and time.
- **History on disk.** Results stay in memory by default. With `"historyEnabled": true` and `"historyPersist": true` they
  are saved to a file only your user can read, so they survive restarts. Clear results deletes it.

From the CLI, snippets are passed per call and commands are off, since stdout has nothing to undo:

```bash
voiceos dictate --text "insert my address" --snippet "my address=1 Infinite Loop, Cupertino"
```

## Commands

```bash
voiceos dictate --text "um so the the meeting is at noon" [--polish] [--app Mail] [--snippet "phrase=text"]...
voiceos edit --selection "hello world" --instruction "make it friendlier"
voiceos agent --text "open /bin/ls and tell me what it does" --mcp voiceos.mcp.json
```

Audio: pass `--audio file.wav` with `WHISPER_MODEL` pointing at a [whisper.cpp](https://github.com/ggml-org/whisper.cpp)
model (and `whisper-cli` on PATH). Transcription is local; a ChatGPT plan does not include a speech-to-text API for apps.

## Agent mode and REA

Copy `voiceos.mcp.example.json` to `voiceos.mcp.json` to give the agent tools. The example registers REA
(`rea-agents`), which needs Ghidra for native binaries. Any MCP server works. Tools appear as `server__tool`.

Safety: a tool runs without asking only if its server marks it read-only (`readOnlyHint`). Everything else asks first
(`--yes` approves all). Declined actions are reported back to the model.

## Develop

```bash
npm test          # vitest
npm run typecheck
```

`src/modes` holds dictation, edit and agent logic; `src/providers` holds Codex, Anthropic, whisper.cpp and text
injectors; `src/mcp` is the MCP tool host.

## Roadmap

Hands-free hotkeys, native text injection for Windows/Linux, on-demand screen context, an integration manifest
with permissions, a secrets vault, and broader macOS app compatibility testing.
