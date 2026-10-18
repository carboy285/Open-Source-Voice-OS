# Coverage

"Specified" means the behavior is fully defined for implementation. Confidence is about how closely the spec **matches the public product behavior**, not about whether it's buildable. Everything is buildable as written.

| Feature | Spec | Status | Confidence | Open questions |
|---------|------|--------|------------|----------------|
| Push-to-talk dictation into the focused app | dictation.md | specified | high | Default hotkey choice of the original is unknown (ours: Right Option/Alt) |
| ~220 wpm effective | dictation.md | specified (latency budget) | medium | How the original measures "effective wpm" is unknown |
| Cleanup: filler, spelling, grammar | dictation.md | specified | high | — |
| List formatting from speech | dictation.md | specified | medium | The exact trigger phrases the original recognizes are unknown |
| Change report | dictation.md | specified | medium | Where/how the original shows it (U- observation would help) |
| Custom dictionary + learning | dictionary.md | specified | medium | How the original learns (edits vs. explicit add) is unknown; ours is edit-watching plus manual |
| Context-aware tone | tone-context.md | specified | medium | The original's category list and rules are unknown |
| 100+ languages, auto-detect | languages.md | specified | high | Depends on the chosen STT model |
| Agent voice-to-action | agent.md | specified | high | — |
| Cursor as context | agent.md | specified | medium | Whether the original uses screenshots, accessibility text or both is unknown |
| Approval gate Edit/Cancel/Send | approval-gate.md | specified | high | — |
| Connectors + Settings toggles + catalog | connectors.md | specified | medium | The original's catalog contents beyond the brief's list |
| Messages connector | connectors.md | partial | low | No public API on macOS; needs AppleScript + Automation permission; Windows has no equivalent |
| MCP via CLI | mcp.md | specified | medium | The original's exact CLI syntax beyond "add mcp" is unknown; ours is Murmur's own |
| Long tasks in side panel, self-reporting | agent.md | specified | medium | — |
| Task history | agent.md | specified | medium | — |
| Reminders | reminders.md | specified | medium | Whether reminders sync to the OS Reminders/Calendar app; ours are local |
| Privacy guarantees | privacy.md | specified | high | — |
| Anonymous opt-in diagnostics | privacy.md | specified | medium | Field list is ours; no endpoint exists |
| Menu-bar / tray app | platform.md | specified | high | — |
| Permission onboarding | platform.md | specified | high | — |
| EN/JA UI | platform.md | specified | high | — |
| Local storage | storage.md | specified | n/a (Murmur design) | — |
| Update mechanism | platform.md | specified | n/a (Murmur design) | — |

## Known unknowns (would need owner trial notes in OBSERVATIONS.md)

1. Default hotkeys and whether toggle mode exists.
2. What the change report looks like and when it appears.
3. Whether dictionary learning is automatic or explicit.
4. Exact list of tone categories.
5. How screen context is captured.
6. Side-panel layout and notification behavior.
7. Whether reminders integrate with OS apps.

None of these block implementation; Murmur's own design (tag `D`) fills each gap.
