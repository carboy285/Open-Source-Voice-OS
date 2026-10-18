# Open Source Voice OS

An open-source voice layer for your computer, in the spirit of tools like VoiceOS: dictate into any app, rewrite
selected text by voice, and hand tasks to an agent that uses MCP tools (including [REA](https://github.com/morluto/rea)
for reverse engineering). Written from public product descriptions only; it contains no code from any commercial app.

> **Status: early.** The engine and CLI work and are tested. The desktop shell (global hotkeys, microphone capture,
> typing into the focused app, screen-pointing overlay) is not built yet.

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

## Commands

```bash
voiceos dictate --text "um so the the meeting is at noon" [--polish] [--app Mail]
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
