# Dictation

## Behavior

The user holds a global hotkey and speaks. When they let go, cleaned text appears at the caret in whatever app has focus (B-D1, B-X2). No window takes focus during dictation (D).

### States

| State | Entered when | Leaves to |
|-------|--------------|-----------|
| idle | app start, or after done/error | listening (hotkey down) |
| listening | hotkey down; mic stream opens; a small on-screen level indicator shows (D) | transcribing (hotkey up), idle (Esc or < 300 ms press, which is treated as accidental) (D) |
| transcribing | audio buffer handed to the STT provider | cleaning, error |
| cleaning | transcript received | inserting, error |
| inserting | text handed to the shell | done, error |
| done | insertion confirmed; the change report is available for 6 s (D) | idle |
| error | any step fails; a short notice says which step and offers retry with the same audio while it is still in memory (D) | idle |

- A **toggle mode** (tap to start, tap to stop) is a setting, default off (D).
- **Double-tap lock** (Mac, a setting, default on): two quick taps of the dictation key (each under 0.3 s, the second starting within 0.4 s of the first being let go) lock dictation on. It keeps listening after the key is let go, the notch says to press the key again to stop, and the next press stops and sends it. Esc cancels. The first, short tap is dropped like any accidental tap. It applies to Shift (agent) and Command (edit) presses too, never to Circle to Ask. It does nothing in toggle mode.
- Audio lives only in memory and is dropped after the transcript is produced or the error notice is dismissed (B-P1, D).

## Cleanup pipeline

Runs in order. Each stage adds entries to the change report (B-D2).

| # | Stage | Needs model? | Report category |
|---|-------|--------------|-----------------|
| 1 | Filler removal (um, uh, er, "you know", "I mean" as a filler, repeated words) | No | `filler_removed` |
| 2 | Spoken punctuation ("comma", "new line") — opt-in, since these are also normal words | No | `punctuation` |
| 3 | Dictionary substitution (`dictionary.md`) | No | `dictionary_applied` |
| 4 | Casing and sentence-final punctuation | No | `formatting` |
| 5 | List detection: "first … second … third …", "one … two …" or "bullet …" with ≥ 2 items becomes a numbered or bulleted list | No (rule) | `list_formatted` |
| 6 | Model polish: grammar, spelling and tone for the app category (`tone-context.md`). Skipped when no LLM is configured | Yes | `spelling_fixed`, `grammar_fixed` |
| 7 | Dictionary learning: words the user corrects after insertion are suggested as entries (`dictionary.md`) | No | `dictionary_added` |

- Model polish must not translate, add content or answer questions in the dictation. If the result's length differs from the input by more than 40 % or its language changes, Murmur keeps the stage-5 text and logs `polish_rejected` (D).
- Spelling/grammar report entries come from a word-level diff of the stage-5 and stage-6 texts (D).

### Change report

A list of entries `{category, before, after}`, shown in a small popover the user can expand from the indicator. It is never sent anywhere (D). Example meaning: "Removed 3 fillers · Fixed 1 spelling · Applied 'Kubernetes'".

## Insertion

| Order | Method | When |
|-------|--------|------|
| 1 | Accessibility insert at the caret (macOS AX value/selected-text attribute; Windows UI Automation ValuePattern/TextPattern) | The focused element supports it |
| 2 | Clipboard paste: save the clipboard, set the text, send the paste shortcut, restore the clipboard after 500 ms | Fallback |
| 3 | Synthetic key typing | Last resort, for fields that block paste; ≤ 2,000 characters |

(D). If all fail, the text is copied to the clipboard and a notice says so (D).

## Latency budget (D)

The target is ~220 wpm effective (B-D1): end-to-end time from hotkey release to text, for a 10 s utterance:

| Step | Budget |
|------|--------|
| STT (local, small model, Apple Silicon / modern x64) | ≤ 700 ms |
| Rule cleanup | ≤ 5 ms |
| Model polish (optional) | ≤ 800 ms, cancelled at 2 s and stage-5 text used |
| Insertion | ≤ 100 ms |

## Edge cases

- An empty or whitespace transcript inserts nothing and shows "Didn't catch that" (D).
- Focus changes during processing: the text goes to the element focused at **release** time; if that element is gone, it goes to the clipboard (D).
- A secure text field (password) is detected → dictation refuses to insert (D).
- Voice edit: with text selected, a second hotkey rewrites the selection by voice instruction (existing Murmur feature, D).

## Permissions

Microphone (to listen); accessibility (to insert and to read the focused element) (B-X3).
