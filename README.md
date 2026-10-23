# Open Source Voice OS

An open-source voice layer for your computer, in the spirit of tools like VoiceOS: dictate into any app, rewrite
selected text by voice, and hand tasks to an agent that uses MCP tools (including [REA](https://github.com/morluto/rea)
for reverse engineering). Written from public product descriptions only; it contains no code from any commercial app.

> **Status: early.** The engine, CLI and the macOS menu-bar app are written, typechecked and unit-tested, but the
> macOS app has not yet been run on a Mac (it was built on Linux). Expect first-run problems and please report them.
> Not built yet: the screen-pointing overlay, Windows/Linux shells, and custom vocabulary.

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

A menu-bar app (Electron). Hold a key, speak, release:

| Hold        | Does                                                     |
| ----------- | -------------------------------------------------------- |
| Right ⌥     | Dictate: cleaned-up text is typed into the focused app   |
| Right ⌘     | Edit: rewrites the selected text from your spoken request |
| Right ⌃     | Agent: runs your request with MCP tools (REA etc.)       |

If another key is pressed while a hotkey is held (for example ⌘C), the recording is cancelled. A tap shorter than
0.3 s is ignored. Status appears in a pill at the top of the screen.

```bash
brew install whisper-cpp          # local speech-to-text
npm install -g @openai/codex      # model access with your ChatGPT plan
npm install && npm run app        # builds and launches
```

Then, from the menu-bar item: **Sign in with ChatGPT (Codex)…**, and **Open settings file…** to set `whisperModel`
to a downloaded ggml model (and `mcpConfig` to give the agent tools). Settings live in
`~/Library/Application Support/Open Source Voice OS/config.json`.

macOS asks for three permissions: **Microphone**, **Accessibility** (to paste text and copy selections) and
**Input Monitoring** (to see the hold-to-talk keys). Grant them in System Settings → Privacy & Security, then restart
the app. Text is inserted by putting it on the clipboard and pressing ⌘V; your previous text clipboard is restored.
Recordings are written to a temporary file for Whisper and deleted right after.

`npm run app:dist` builds an unsigned `.dmg`; signing and notarization need your Apple developer credentials.

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
permission; "scratch that" is a plain ⌘Z, so it undoes whatever the focused app did last — the insertion in normal use.

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

Desktop app shell, hold-to-talk and hands-free hotkeys, microphone capture, native text injection (macOS, Windows,
Linux), custom vocabulary, on-demand screen context, an integration manifest with permissions and a secrets vault.
