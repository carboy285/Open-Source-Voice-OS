# Notch surfaces (macOS)

Murmur's short-lived surfaces appear at the top center of the screen, growing out of the MacBook camera notch (U-1, D). This covers four surfaces; the full side panel for long tasks stays docked at the screen edge (`agent.md`).

Everything below is a Murmur design decision (D) unless tagged otherwise. The visual design is Murmur's own.

## Which screen and where

| Situation | Placement |
|-----------|-----------|
| The screen with the pointer has a notch (built-in display) | Surfaces grow out of the notch: same center, top edge flush with the top of the screen, starting at the notch's width |
| That screen has no notch (external display, lid closed, older Mac) | Murmur draws its own black, pill-shaped "notch" at the top center, about the width and height of a real one, and grows the same surfaces out of it. The pill is only visible while a surface is showing |
| Full-screen app in front | Surfaces still appear above it |
| Multiple Spaces | Surfaces follow the active Space |

The notch area is found from the screen's safe-area insets and the auxiliary top areas on either side of the camera housing. Without them, the screen is treated as notch-less.

## Surfaces

| Surface | Shown when | Content | Size |
|---------|-----------|---------|------|
| Listening | Hotkey down, until the text is inserted or listening is cancelled | Live microphone level, the mode (dictate / ask / edit), and the step after release (transcribing, cleaning) | Slightly wider than the notch, the notch's height plus a little |
| Change report | After a dictation is inserted, for 6 s or until dismissed (`dictation.md`) | The change summary; it expands to the full list on hover or click, with Undo for a learned dictionary word | A short strip under the notch; taller when expanded |
| Approval | A gated tool call needs a decision (`approval-gate.md`) | The preview: tool, summary, editable fields, Edit / Cancel / approve button | A card about 460 pt wide, hanging from the notch |
| Task progress | A long task is running and nothing else is using the notch | The task's current step and a step count; a click opens the side panel | Compact: a little wider than the notch |

## Priority and queueing

1. **Listening always wins.** Pressing the hotkey takes over the notch at once, within the same frame as the key press.
2. **Approvals come next.** While listening or showing a change report, a pending approval shrinks to a badge beside the notch ("1 waiting", with the count) and returns as soon as the notch is free. Several pending approvals queue in arrival order; the badge shows how many.
3. **Change reports** show after listening ends. If an approval is pending, the report is shown first for its 6 s, then the approval returns.
4. **Task progress** shows only when nothing above needs the notch.

The **typing box** (below) sits between listening and change reports: it is opened by the user, so it outranks a report or an approval that arrives meanwhile; those wait behind it.

When a surface is replaced, it shrinks back into the notch along the path it came out, and the next one grows out.

## Typing box

For people who can't or would rather not speak. ⌃⌥T (or Ask by typing… in the menu) opens a card that grows out of the notch with a text field, an Ask / Edit switch, New chat, a Send button and a close button. The app and the selection are read **before** the card takes focus, and sent with the request, so Edit still works on the text the user had selected. Return sends; Esc or the close button closes. Clicking into another app closes it, and holding the dictation key closes it. After sending, the card closes, focus goes back to the user's app, and the reply shows as usual (and is read aloud if Spoken replies is on). It never opens while the microphone is open.

## Conversation view

The typing box has a down arrow (the up arrow folds it back). Opened down, the box becomes a conversation: the Ask box stays at the top and the chat so far sits under it, oldest first, newest at the bottom, scrolled to the latest. Your messages are blue on the right, the answers are on the left, and under each reply a few small lines say what the agent did (a failed step in orange). A message you just sent shows at once with the current step under it. Text can be selected and copied. The box stays open after sending, so it can be an ongoing conversation; Edit mode is not offered while it is open down, and Esc or the close button closes it without losing the chat. Voice requests and Circle to Ask requests made while the conversation exists show up in it too, because the core keeps one record of the chat. If an approval arrives while the conversation is open it takes the notch (the agent has to be allowed to carry on) and the conversation returns after it; what was typed is kept. The chat is the same memory the AI uses: it starts over after 30 quiet minutes or with New chat, it holds the last 40 requests at most, and it is never written to disk. Requests that failed or were cancelled show in it but are not remembered by the AI. The answer card that appears after a request has a down arrow too, which opens the conversation with that answer in it. "Open chat" in the menu bar opens the box already down. The choice of open or folded is remembered.

## Circle to Ask

Hold the dictation key with Control (Right Option + Control by default) and a faint sheet covers the screen under the pointer, with a crosshair. Press the mouse and drag around something (a loop or a box); let go to finish. The sheet leaves, Murmur takes a picture of just that area (never its own windows), reads the words in it on the Mac, and a card grows out of the notch: a small preview, quick questions (Explain, Search the web, Translate, Copy text) and a text box. Letting go of the key before drawing, or pressing Esc, cancels. A drawing smaller than 24 points means nothing. The question goes to the agent with the picture (for a model that can see) and the words read from it, so replies, follow-ups, spoken replies and approvals all work as for any Ask. Copy text uses no AI. It needs macOS 14 and Screen Recording; without them the card never opens and a message says what to allow. It never opens while the microphone is open.

"Include a picture of my window" on the typing card (or Settings › Include a picture of my window with every Ask) adds the biggest window of the app you were in to an Ask, even when something covers it.

## Coding agents

When Codex, Claude Code or OpenCode (started from Murmur) stops to ask, the question is an approval card of kind "agent": the agent's name, what it wants (the exact command, file change or question) and the folder. Commands and file changes are allowed or refused exactly as shown and cannot be edited; a question has a text box for the answer. A risky command (deleting files, `sudo`, force-push and the like) asks twice, with a separate confirm step. No answer, a timeout or closing the card is "no". When an agent finishes or fails, a notification says so. Settings › Connectors lists detected agents, their switches, recent runs and a Stop button. Cue and other agents that act for the user in the outside world are not controlled.

## Computer actions

Opening a file, link or app, quitting an app, clicking, typing, pressing keys and choosing a menu item are approval cards of kind "computer". The title is one plain sentence Murmur writes itself ("Click the button "Send" in Mail"); for clicks and typing into a field it names the button or field from the screen reading Murmur did, not from the model's words. A click or type is refused if the item changed since it was read. Murmur's own windows, terminals, password managers and System Settings cannot be controlled, and password fields are never read or typed into.

## Spoken replies

Agent replies are read aloud with the Mac's own voices when Read replies aloud is on (Settings › Agent): the chosen voice, or the best installed voice for the reply's language, at the chosen speed. Speech stops when the dictation key is pressed, when the typing box opens, when a new request is sent, or from the speaker button on the reply card. Nothing is sent anywhere for speech.

## Keyboard and focus

- No surface takes keyboard focus when it appears. The user's app keeps focus and their typing is never redirected.
- The approval card becomes focused when clicked, or with the focus shortcut (default ⌃⌥A; ⌃⌥Space is taken by macOS input-source switching). Focused, it accepts: ⌘Return to approve, Esc to cancel, Tab to move between fields and buttons. **Plain Return never approves.** When the card closes, focus returns to the app that had it.
- Editing fields (after Edit) needs focus, which the click or shortcut provides.

## Approval rules specific to the notch

- No screen dimming.
- A pending approval waits until the user acts, or until the approval timeout cancels it (10 minutes by default, `approval-gate.md`).
- While an approval waits, the notch area shows a gentle pending indicator (a slow, low-contrast pulse on the badge, at most once every 2 s; none with Reduce Motion).
- Destructive actions keep their second confirmation.

## Motion

- Surfaces grow out of the notch and shrink back into it along the same path: width and height animate together from the notch's own size.
- Use springs that never overshoot (critically damped) for growing and shrinking; no bounce.
- Every animation can be interrupted. Pressing the hotkey while a card is shrinking reverses it from its current size; nothing waits for an animation to finish, and input is never blocked during one.
- The listening surface appears with no delay on hotkey down.

## Look

- The surface is black through the notch and eases into a deep charcoal below it, so it still joins the hardware notch. An approval card adds a faint blue glow along the bottom edge.
- Content fades in with a small rise and a soft blur, one item after another (about 60 ms apart). With Reduce Motion it is a plain fade.
- **Preview cards.** An approval is drawn as a card that fits the task, chosen by the core from the tool and its input (`src/gate/card.ts`): a header with the app and a label (New event, New email, New reminder, New message, File change), the title with an accent rule, then rows. An event shows the time ("Thursday · 2:00 – 2:30 PM"), people as pills, the place and a short note; an email shows recipients and a short body; a reminder shows its time and list. A video call that will be added shows as a badge beside the buttons. A tool the core does not recognise gets a generic card with the first few values. The card is only a way to draw the preview: Edit still shows every field, and Details still shows the raw input. Card text is plain text and is cut to a fixed length.
- Reduce Transparency and Increase Contrast: plain black, no gradient or glow.

## Accessibility

- **Reduce Motion:** cross-fade between surfaces instead of growing and shrinking; no pulse.
- **Reduce Transparency:** solid backgrounds.
- **Increase Contrast:** a visible border on cards.
- **VoiceOver:** each surface posts an announcement when it appears ("Listening", "Approval needed: Send email to …", the change summary). Every control has a label, and the approval card is reachable with the focus shortcut.
- Text uses the system font and follows the user's text size within the card's maximum height; long content scrolls inside the card.

## Edge cases

- The pointer moves to another screen while a surface is showing: the surface stays where it is until it closes; the next one opens on the pointer's screen.
- Screen configuration changes (lid closed, display unplugged): open surfaces move to the new primary screen's notch or pill.
- The menu bar is set to auto-hide: surfaces appear the same way.
- Clicking outside a card never cancels an approval; only Cancel, Esc (when focused), closing it, or the timeout does.
