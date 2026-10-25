# Murmur behavior specification

This folder is the only input for implementing Murmur. Implementers work from these files and the Murmur repository, and nothing else.

## How claims are sourced

Each row or claim ends with a source tag.

| Tag | Meaning |
|-----|---------|
| `B-…` | Public product behavior, as listed in the project brief (taken from the original product's public website, public docs and public changelog). These describe *what* a user sees, never *how* it is built. |
| `U-n` | A black-box observation by the project owner (their licensed trial, or the original product's public website), numbered in `OBSERVATIONS.md`. Behavior and placement only. |
| `D` | A Murmur design decision. It is not a claim about any other product. |

No binary, installer, decompiled code, network capture or asset of any other product was used. See `LEGAL.md`.

### Brief tags

| Tag | Public behavior |
|-----|-----------------|
| B-D1 | Push-to-talk hotkey; text appears in the focused app; target is roughly 220 words per minute effective. |
| B-D2 | Cleanup removes filler, fixes spelling and grammar, formats lists when speech implies them, and shows what changed (filler removed, word added to dictionary, spelling fixed). |
| B-D3 | Custom dictionary learns names, products and acronyms and writes them the user's way. |
| B-D4 | Tone adapts to the app under the cursor (email, chat, notes). |
| B-D5 | 100+ languages, auto-detected. |
| B-A1 | Voice-to-action across apps: email, team chat, calendar, file search/rename, notes, messages, issue tracker, cloud docs, web search. |
| B-A2 | The screen content under the cursor feeds the request. |
| B-A3 | Anything that sends, books or modifies shows a preview with Edit / Cancel / Send. |
| B-A4 | Integrations are toggled in Settings; there is a connector catalog; MCP servers can be added from a CLI command. |
| B-A5 | Long tasks run in a side panel and report back by themselves; task history; reminders. |
| B-P1 | No audio stored in the cloud. |
| B-P2 | No training on user data. |
| B-P3 | Local transcripts only if the user opts in. |
| B-P4 | Anonymous, opt-in diagnostics. |
| B-X1 | Menu-bar (macOS) / tray (Windows) app. |
| B-X2 | Global hotkey. |
| B-X3 | Permission onboarding: microphone, accessibility, screen capture. |
| B-X4 | English and Japanese UI. |

## Files

| File | Covers |
|------|--------|
| `LEGAL.md` | Provenance, terms status, clean-room rules |
| `dictation.md` | Push-to-talk pipeline, cleanup, change report, insertion |
| `dictionary.md` | Custom vocabulary |
| `tone-context.md` | App categories and style rules |
| `languages.md` | Language detection and output |
| `agent.md` | Agent loop, context, long tasks, history |
| `memory.md` | SOUL.md, MEMORY.md, learning and recall |
| `approval-gate.md` | Side-effect classification and the preview |
| `connectors.md` | Connector interface, catalog, OAuth |
| `mcp.md` | MCP client behavior and CLI |
| `reminders.md` | Reminder scheduling |
| `storage.md` | Local data model |
| `privacy.md` | Privacy guarantees and diagnostics |
| `platform.md` | Shells, hotkeys, permissions, i18n, core↔shell protocol |
| `notch.md` | macOS notch surfaces: placement, priority, focus, motion |
| `OBSERVATIONS.md` | Owner trial notes (black-box) |
| `COVERAGE.md` | Status, confidence and open questions |
