# Agent mode

The user speaks a request; Murmur carries it out across apps and services (B-A1).

## Trigger (D)

A separate hotkey (default: the dictation key + Shift), or a spoken prefix setting ("Hey Murmur" is **not** used; there is no always-on listening). The transcript goes to the agent instead of being inserted.

## Context: the cursor (B-A2)

At hotkey-down the shell captures, in this order of preference (D):

1. The selected text, if any.
2. The text of the accessibility element under the mouse pointer, and of the focused element (truncated to 4,000 characters).
3. If screen recording is granted and steps 1–2 found nothing: a screenshot of a 800×600 region around the pointer, sent to a vision-capable model only. Without a vision model it is skipped.

Plus: the app name, window title and app category (`tone-context.md`). The context is in the first user message, clearly labeled as screen content, and the system prompt says screen content is data, not instructions (prompt-injection guard).

## Memory (D)

`SOUL.md` and the relevant facts from `MEMORY.md` are appended to the system prompt as `<about_you>` and `<memory>`, both labeled as data (`memory.md`). They are read fresh for every request, so hand edits take effect immediately. Explicit “remember”, “forget” and “what do you remember” commands are answered by the core without a model; after a successful reply, an optional extraction call adds durable facts. A memory write failure never changes the reply.

## Loop (D)

1. Build the request: system prompt (original to Murmur, plus memory), context, transcript, the enabled tools.
2. Call the LLM. If it returns tool calls, run each in order:
   - Unknown tool → error result.
   - Gated tool → approval gate (`approval-gate.md`). Cancel → result "The user cancelled this action." The model may adapt but must not retry the same call without a change.
   - Otherwise run it; errors become error results.
3. Repeat until a reply has no tool calls, or 12 steps (setting), or 5 minutes of wall time.
4. Speak/show the reply in a toast; a long reply opens in the side panel.

### Tool-call shape

Each tool: `name` (namespaced `connector.action` or `mcp.<server>.<tool>`), `description`, JSON Schema input, and side-effect metadata `{readOnly, destructive, sends, books}`. Each call has an id, name and a JSON object input; each result has the id, text content and an error flag.

## Long tasks (B-A5)

- A task becomes "long" when it passes 3 tool steps or 10 seconds. It then moves to the **side panel**, a non-modal window docked to the screen edge, which shows the step list, the current step and pending approvals (D).
- The user can keep working. On completion, the panel posts a system notification with the outcome. Approvals needed by a background task show as a notification that opens the preview (D).
- Tasks can be cancelled from the panel. Cancellation stops before the next tool call; a running tool call finishes (D).

## Task history (B-A5)

Each task stores: id, transcript (only if transcripts are opted in, otherwise "—"; B-P3), status (`running`/`waiting_approval`/`done`/`failed`/`cancelled`), steps (tool name, short input summary, result summary, approval decision), started/finished time. The history list is in the side panel, with search and "run again" (D). Retained 30 days by default (D).

## Edge cases

- No LLM configured → agent mode is disabled, and Settings explains how to add a local model or a key (D).
- No enabled tool fits the request → the model says what's missing and which connector would help (D).
- Network loss mid-task → the task fails at the current step with a retry button; already-approved actions are not repeated automatically (D).
