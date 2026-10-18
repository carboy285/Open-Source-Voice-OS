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

When a surface is replaced, it shrinks back into the notch along the path it came out, and the next one grows out.

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
