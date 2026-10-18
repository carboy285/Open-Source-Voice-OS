# Approval gate

Anything that sends, books or modifies shows a preview first, with **Edit / Cancel / Send** (B-A3).

**Invariant (D): no tool classified as gated is executed unless the user chose Send (or Save after Edit) for that exact call and input.** No setting, model output or connector can turn this off for a single call. An "always allow" per tool exists only for tools that are `readOnly`.

## Classification (D)

| Source of metadata | Gated when |
|--------------------|------------|
| Built-in connector action | the action declares `sends`, `books`, `modifies` or `destructive` |
| MCP tool | `annotations.readOnlyHint` is not `true` (missing → gated). Hints from a server can only **add** gating: a server cannot make a built-in action ungated |
| Anything else / unknown | gated |

`readOnly` tools (search, read, list) run without a prompt.

## Preview payload (D)

| Field | Content |
|-------|---------|
| call_id | the tool call id |
| tool | display name and connector icon (Murmur's own icons) |
| verb | Send · Book · Save · Rename · Delete · Run |
| summary | one line generated from the input by the connector (not the model), e.g. "Email to ana@example.com — 'Q3 numbers'" |
| fields | an ordered list of editable fields `{key, label, type: text/longtext/datetime/recipients/path, value}` built from the input schema |
| raw | the full JSON input, shown under "Details" |
| risk | `normal` · `destructive` (destructive uses a red button and needs a second click) |

## States

`pending` → `edited` (zero or more times) → `approved` | `cancelled` | `expired`.

- **Send/approve**: the tool runs with the shown values.
- **Edit**: fields become editable; Save validates against the schema and shows the preview again with the new values. Approval always applies to what was last shown.
- **Cancel**: nothing runs. The model is told the user cancelled.
- **Expired**: no response in 10 minutes (setting) → treated as Cancel.
- Closing the preview = Cancel.

## Keyboard and placement (U-1, D)

- On macOS the preview appears at the notch (see `notch.md`). It does **not** take keyboard focus when it appears, so typing in the user's app continues undisturbed.
- The user focuses it by clicking it or with the focus shortcut (default ⌃⌥A; ⌃⌥Space is taken by macOS input-source switching). Once focused: **⌘Return** approves, **Esc** cancels, Tab moves between controls. **Plain Return never approves.**
- The screen is not dimmed. A pending preview waits until the user acts or the timeout above cancels it; the notch shows a pending indicator meanwhile.

## Edge cases

- Several gated calls in one model turn: one preview each, in order; cancelling one doesn't cancel the others (D).
- If the model changes its input after approval (a new call), that is a new preview (D).
- Background tasks: the preview opens from a notification, and the task waits in `waiting_approval` (D).
