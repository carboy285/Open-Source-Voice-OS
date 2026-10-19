# Approval gate

Anything that sends, books or modifies shows a preview first, with **Edit / Cancel / Send** (B-A3).

**Invariant (D): no tool classified as gated is executed unless the user chose Send (or Save after Edit) for that exact call and input, or the user themselves switched on an approval mode that covers it (see Approval modes).** The model, a connector or a tool result can never change the mode, and anything that is not exactly `auto` or `full` means `ask`. An "always allow" per tool exists only for tools that are `readOnly`.

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

## Approval modes

A user-set preference (`approval.mode`, Settings › General › How should Murmur's actions be approved?, and the menu bar's Approvals menu). It covers connectors, the computer tools and Composio apps; it does not cover coding agents' own command questions, which always ask.

- **Ask for approval** (`ask`, the default): every gated call shows a preview first.
- **Approve for me** (`auto`): routine calls run without a preview and show in the task's steps as automatic. A call still asks when it can reach other people (any recipients, attendees or guests, or an action that sends), deletes (destructive), comes from an MCP server (it can't be judged), starts a coding agent, or is a click, menu item or key whose own words say send, delete, pay and the like (or a key that sends, deletes or quits, or typed text containing a new line). A click Murmur cannot describe from the screen it read also asks.
- **Full access** (`full`): nothing asks. Turning it on is confirmed once in Settings and cannot be done from the menu bar. The computer tools' hard limits stay: Murmur's own windows, terminals, password managers and System Settings are never controlled, and password fields are never read or typed into.

The mode is read for every action, so a change applies to the next call, even in a task that is already running.
