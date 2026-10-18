# Testing Murmur on a Mac

A hands-on checklist for the first real run of the macOS app. Work through it in order, and note the step number and what you saw for anything that fails.

## 0. Get the build

Use one of these:

- **CI artifact:** find the run id of the latest successful CI run for the branch, then download its `murmur-macos-dmg` artifact. `gh run download` has no `--branch` flag, so list runs first:

  ```sh
  gh run list --repo carboy285/Open-Source-Voice-OS --branch claude/open-source-voiceos-alt-h4r7fn --workflow CI --status success --limit 1
  gh run download <run-id> --repo carboy285/Open-Source-Voice-OS --name murmur-macos-dmg --dir ~/murmur-dmg
  ```

  The folder then holds `Murmur-<version>-macos-universal.dmg`. You can also download the artifact from the run's page on GitHub Actions and unzip it.

- **From source** (needs Node 22 and Xcode 15+):
  ```sh
  git clone https://github.com/carboy285/open-source-voice-os.git
  cd open-source-voice-os
  git checkout claude/open-source-voiceos-alt-h4r7fn
  npm ci && npm test && npm run bundle:core
  scripts/package-macos.sh        # writes build/installers/*.dmg
  ```

The speech model is downloaded from inside the app (step 3.0). Homebrew isn't needed: the speech engine ships inside Murmur.app.

## 1. Install

| #   | Do                                                | Expect                                                                                                            |
| --- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1.1 | Open the `.dmg`                                   | A window with Murmur and an Applications shortcut                                                                 |
| 1.2 | Drag Murmur to Applications, eject the disk image | —                                                                                                                 |
| 1.3 | Right-click Murmur in Applications › Open › Open  | The build is unsigned, so macOS warns once. If it refuses, use System Settings › Privacy & Security › Open Anyway |
| 1.4 | Look at the menu bar                              | A Murmur icon appears. There is no Dock icon                                                                      |

## 2. Onboarding and permissions

| #   | Do                                                                      | Expect                                                                                                    |
| --- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 2.1 | First launch                                                            | The onboarding window opens, in Japanese if your Mac is set to Japanese                                   |
| 2.2 | Grant Microphone                                                        | The system prompt appears; the row turns to granted without restarting                                    |
| 2.3 | Grant Accessibility (the button opens System Settings)                  | After you switch Murmur on, the row updates within a few seconds                                          |
| 2.4 | Skip Screen Recording                                                   | The app keeps working; agent screenshots are simply not used                                              |
| 2.5 | Close onboarding, then reopen it from the menu                          | The permission status is still correct                                                                    |
| 2.6 | With Murmur running, switch Accessibility off and on in System Settings | Within a few seconds the hotkey works again without restarting Murmur (the log says "hotkey tap rebuilt") |

## 3. Dictation

**3.0 Speech model.** In the first-run window (or Settings › Dictation, engine "NVIDIA Parakeet"), click Download on the recommended (Balanced) model. Expect a progress bar, then "In use" and a notification that the model is ready. The file lands in `~/Library/Application Support/Murmur/models/ggml-parakeet-tdt-0.6b-v3-q8_0.bin`. Also try Cancel during a download (nothing is left behind) and Delete.

To use whisper.cpp instead (for Japanese), switch the engine in Settings › Dictation and choose `whisper-cli` and a `ggml-*.bin` model; `whisper-cli` ships inside the app, and the picker also accepts a Homebrew one.

| #    | Do                                                                                                                                                            | Expect                                                                                                                                                                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1  | Click into TextEdit. Hold Right Option, say "um so the meeting is uh at noon", let go                                                                         | "So the meeting is at noon." appears at the cursor                                                                                                                                                                                                  |
| 3.2  | Watch the screen while you press                                                                                                                              | The listening surface grows out of the notch the instant you press the key                                                                                                                                                                          |
| 3.3  | Check the change card after inserting                                                                                                                         | It lists the removed fillers and disappears after a few seconds                                                                                                                                                                                     |
| 3.4  | Tap Right Option very briefly                                                                                                                                 | Nothing is inserted (a press under 300 ms counts as accidental)                                                                                                                                                                                     |
| 3.5  | Hold, start speaking, press Esc                                                                                                                               | Listening is cancelled and nothing is inserted                                                                                                                                                                                                      |
| 3.6  | Say "first buy milk second call Ana third book flights" in Notes                                                                                              | A three-item list                                                                                                                                                                                                                                   |
| 3.7  | Dictate into Slack or Messages, then into Mail                                                                                                                | Chat output is casual with no trailing period; Mail gets full sentences                                                                                                                                                                             |
| 3.8  | Dictate into a password field                                                                                                                                 | Murmur refuses to insert                                                                                                                                                                                                                            |
| 3.9  | Dictate into a browser text box and into VS Code                                                                                                              | Text arrives (by paste if direct insertion fails), and the clipboard is restored afterwards                                                                                                                                                         |
| 3.10 | Speak Japanese                                                                                                                                                | Japanese text with 。, no added spaces                                                                                                                                                                                                              |
| 3.11 | Select text, hold Right Option + Command, say "make this more formal"                                                                                         | The selection is rewritten (needs a model in Settings › Agent)                                                                                                                                                                                      |
| 3.12 | Fresh install: grant Accessibility and Input Monitoring, click into a blank TextEdit document, dictate                                                        | The text appears at the cursor, and your previous clipboard comes back                                                                                                                                                                              |
| 3.13 | Switch Accessibility off and on (or install a new build over the old one), then dictate into TextEdit again                                                   | The text appears, or the notch says "Couldn't paste. Text is on your clipboard. Check Accessibility / Input Monitoring." and Cmd+V pastes the dictation. It must never stay silent                                                                  |
| 3.14 | After 3.12 or 3.13, run `log show --last 2m --predicate 'subsystem == "app.murmur" && category == "insert"' --info`                                           | One `insert app=… role=… trusted=… post=… listen=…` line, the routes tried with their result codes, and the outcome. No dictated text appears                                                                                                       |
| 3.15 | Dictate 20 times in a row, some quick, some right after the previous text appears, some while the change card is still showing. Also hold the key and tap Esc | The notch is visible for the whole hold every time. The orange microphone dot is gone within a second of letting go. If it ever lingers, the log (`log show --last 5m --predicate 'process == "Murmur"'`) has a "microphone was open" line; send it |

If 3.13 fails with `post=false` or `trusted=false`: an ad-hoc signed build gets a new code identity on every update, so the old Accessibility entry no longer matches. Reset it with `tccutil reset Accessibility app.murmur`, `tccutil reset ListenEvent app.murmur` and `tccutil reset PostEvent app.murmur`, reopen Murmur and grant again. Send the log lines from 3.14 with your report.

An app that exposes no text to read (some Electron apps) can't be checked. Murmur then trusts the paste and leaves the dictated text on the clipboard.

## 4. Agent and the approval gate

In Settings › Agent, add an Anthropic API key or a local OpenAI-compatible server (e.g. LM Studio or Ollama).

| #    | Do                                                                       | Expect                                                                                                                                   |
| ---- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1  | Hold Right Option + Shift, say "remind me to stretch in two minutes"     | An approval card hangs from the notch with the reminder and its time, with Edit, Cancel and Save                                         |
| 4.1b | Hold Right Option first, then add Shift, and speak                       | Agent mode: the notch switches to Ask while you hold. Letting go of Shift before Right Option keeps agent mode                           |
| 4.2  | Press Cancel                                                             | Nothing is created; the reply says you cancelled                                                                                         |
| 4.3  | Repeat, press Edit, change the text, Save, then approve                  | The preview shows your edited text before you approve; the reminder uses it                                                              |
| 4.4  | Wait two minutes                                                         | A notification fires with Snooze and Done                                                                                                |
| 4.5  | Repeat 4.1, click the card, then press Esc                               | Treated as Cancel                                                                                                                        |
| 4.6  | Ask to rename a file in a test folder (enable the Files connector first) | A preview appears before anything changes                                                                                                |
| 4.7  | Ask something read-only: "what reminders do I have"                      | It answers with no approval prompt                                                                                                       |
| 4.8  | Ask a multi-step task                                                    | It moves to the side panel, which slides in from the screen edge. You can keep typing elsewhere. A notification arrives when it finishes |
| 4.9  | Cancel a running task from the side panel                                | It stops before the next step                                                                                                            |
| 4.10 | Open History in the side panel                                           | Past tasks are listed; the transcript shows "—" unless Keep transcripts is on                                                            |

**4.0 ChatGPT subscription.** In Settings › Agent choose "ChatGPT subscription" and click "Sign in with ChatGPT". Murmur shows a code and opens OpenAI's page. Enter the code there and approve. Expect "Signed in as <your email>" within a few seconds, and no API key needed. Then hold Right Option + Shift and ask for something simple. "Sign out" removes it. The sign-in is stored in your keychain as `llm/chatgpt`; the API key option still works.

### 4.4 Approval cards

1. Say "Add lunch with Sam tomorrow at noon to my calendar." The approval card has a black top that joins the notch, a charcoal body, a faint blue glow along the bottom, and a header reading "New event". The title has a blue line under it. Below it: the time ("Tomorrow · 12:00 – 1:00 PM"), then Sam's address as a pill if there is one. The rows fade in one after another, not all at once.
2. Say "Email Ana that I'll be late." The card says "New email", with Ana's address as a pill and a short body.
3. Say "Remind me to call Mum tomorrow at 5." The card says "New reminder" with the time.
4. Click Edit: the card turns into the plain fields. Save returns to the card with the new values.
5. Ask for something unusual (an MCP tool): a generic card with the first few values, never a blank card.
6. System Settings › Accessibility › Display: turn on Reduce Motion (rows just fade, no rise or blur), then Reduce Transparency (plain black, no gradient or glow).

### 4.45 Typing, conversation and spoken replies

1. Press ⌃⌥T. A card grows out of the notch with a text field that already has the cursor, an Ask / Edit switch, "New chat" and Send. Your app keeps its place: type, press Return, and the app you were in gets focus back.
2. In Ask, type "What time is it?" and press Return. The reply shows and is read aloud in a natural voice, in the language of the reply. Press the dictation key: the voice stops at once.
3. Follow up without repeating anything: type "And tomorrow?" or "Make that an hour later." The answer clearly uses the first exchange (it knows what "that" is).
4. Ask by voice (hold the Ask hotkey) "What did I just ask you?" It knows. Then press ⌃⌥T, click New chat, and ask the same again: it no longer knows.
5. Wait 30 minutes (or restart Murmur) and ask a follow-up: it starts fresh.
6. Select a paragraph in Notes, press ⌃⌥T, switch to Edit, type "make it shorter" and press Return. The selection is replaced in Notes. With nothing selected, the card says the result goes at the cursor.
7. Press ⌃⌥T, then click into another app: the box closes without sending. Press ⌃⌥T while holding the dictation key: nothing opens.
8. Settings › Agent › Spoken replies: turn Read replies aloud off and ask again (silent). Pick another voice and press Test voice. Move the Speed slider and test again. While a reply is speaking, the reply card shows a small speaker button that stops it.

### 4.46 Circle to Ask and the screen

1. Settings › Agent › Circle to Ask and screen: the switch is on. If it says "Needs Screen Recording", click Allow…, turn Murmur on in System Settings › Privacy & Security › Screen Recording, and reopen Murmur.
2. Hold Right Option + Control. The screen dims a little and the pointer is a crosshair. Let go without drawing: the dimming goes away and nothing opens.
3. Hold the keys again, press the mouse and drag a loop around a photo, a chart or a paragraph on a web page, then let go of the mouse. A card grows out of the notch showing "Reading the area…", then a small preview of what you circled, four quick buttons and a text box with the cursor in it.
4. Press Explain. The reply describes what you circled (not the whole screen) and is read aloud if Spoken replies is on. Then type "and what is the second line?" and press Return: it uses the first answer.
5. Circle some text and press Copy text: "Copied N characters" appears, and pasting elsewhere gives the words in the area. Press Esc on the card: it closes without sending.
6. Circle a very small area or just click: nothing happens. Press Esc while drawing: it cancels.
7. Press ⌃⌥T, turn on "Include a picture of my window", and ask "What am I looking at?" The answer is about the app you were in. Turn on Settings › Include a picture of my window with every Ask and ask by voice: same.
8. With a model that cannot see images (an OpenAI-compatible server with "My model can see images" off), circle some text and press Explain: it answers from the words read in the area.
9. Turn off Screen Recording for Murmur in System Settings and hold the keys: no sheet appears, a message says what to allow.
10. Ask "reply to this email saying I'll be there at 3" with an email open: an approval card named "Write into the app" shows the text. After you approve, it appears in the reply box; it never types into a password field.

### 4.5 Apps through Composio

1. Settings › Apps shows a field for a Composio API key. Paste a wrong key: you see "Composio didn't accept the API key". Paste a real one: the key is saved and a list of apps appears, with the most used first.
2. Search "calendar" and press Return: Google Calendar is in the results.
3. Click Connect on Google Calendar. Your browser opens Google's sign-in. Finish it: the row gets a green check within a few seconds and shows "Agent can use it" and "Read only".
4. Hold the agent key and say "What's on my calendar tomorrow?" The answer lists real events and no approval appears (reading is automatic).
   Also say "What's on my Google Calendar today?" The answer names today's real date (check the weekday and day) and today's events, not another day.
5. Say "Add lunch with Sam tomorrow at noon to my calendar." An approval appears with the details; Edit works; approving adds the event.
6. Turn on Read only for Google Calendar, repeat step 5: the agent says it can't add events.
7. Disconnect Google Calendar, then say "What's on my calendar?" The agent asks to connect it (an approval named "Connect an app"). Approve it, finish the sign-in, and it carries on and answers.
8. Remove the key, then ask for your calendar again: you are told to add the Composio key in Settings › Apps.

### 4.6 Mail, Calendar and Reminders on this Mac

1. Settings › Connectors: turn on "Mail (Mac)", "Calendar (Mac)" and "Reminders (Mac)".
2. Say "Summarize my unread mail." macOS asks whether Murmur may control Mail; allow it. The reply names real senders and subjects. No approval appears.
3. Say "Read the one from <sender>." The reply summarizes that message.
4. Say "What's on my Apple calendar this week?" macOS asks for Calendar access; allow it. The events match the Calendar app.
5. Say "Remind me to call Mum tomorrow at 5." An approval appears. After you approve, the item is in the Reminders app with that time.
6. Say "What's on my reminders?" and then "Mark the call Mum one as done." Approve; the item is checked off in Reminders.
7. Say "Draft an email to <someone> saying I'll be late." An approval appears; after approving, a draft window opens in Mail. Nothing is sent.
8. Deny a permission in System Settings › Privacy & Security, ask again: the reply tells you where to allow it.

### 4.7 Coding agents (Codex, Claude Code, OpenCode)

1. Settings › Connectors › Coding agents: each agent you have installed shows with a switch. One that needs a sign-in says so. Grok Build and Cue are not listed.
2. Hold the agent key and say "Ask Codex to list the files in <a test folder>." An approval appears first for starting the agent (it names the folder). Approve.
3. A card named "Coding agent" appears in the notch when Codex wants to run a command or change a file. It shows the exact command and folder. Allow it: Codex continues. Run it again and say No: Codex is told no and carries on without it.
4. Leave a card unanswered until it times out: it closes and counts as No.
5. Ask for something risky ("delete the build folder with rm -rf"). The card asks twice; the second step is a separate confirm.
6. Settings › Connectors › Coding agents: the run shows its latest message and a Stop button; Stop ends it. A notification arrives when an agent finishes.
7. Repeat steps 2 to 3 with OpenCode and Claude Code (Claude Code needs `claude auth login` first).

## 5. MCP

```sh
ln -s /Applications/Murmur.app/Contents/Resources/core/murmur /usr/local/bin/murmur
murmur add mcp everything -- npx -y @modelcontextprotocol/server-everything
murmur list mcp
```

| #   | Do                                    | Expect                                                              |
| --- | ------------------------------------- | ------------------------------------------------------------------- |
| 5.1 | `murmur list mcp`                     | Shows `everything` with a tool count                                |
| 5.2 | Ask the agent to use one of its tools | Tools without a read-only annotation show an approval preview first |
| 5.3 | `murmur remove mcp everything`        | It's gone from the list and the agent                               |

## 6. Look and feel

| #   | Do                                                                | Expect                                               |
| --- | ----------------------------------------------------------------- | ---------------------------------------------------- |
| 6.1 | Switch between light and dark mode                                | All windows follow                                   |
| 6.2 | Turn on System Settings › Accessibility › Display › Reduce motion | Panels cross-fade instead of sliding                 |
| 6.3 | Turn on Reduce transparency                                       | Panels and popovers become solid                     |
| 6.4 | Open the side panel, then close it and reopen it quickly          | It reverses smoothly from where it was, with no jump |
| 6.5 | Turn on VoiceOver, tab through the approval card                  | Every control is labeled and reachable by keyboard   |
| 6.6 | Open Settings (also try with the language set to Japanese)        | All six tabs show in the tab bar, with no ">>" menu  |

## 7. Privacy

| #   | Do                                                                                   | Expect                                                         |
| --- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| 7.1 | Dictate several times, then run `find ~/Library/Application\ Support/Murmur -type f` | No audio files, only the database and the MCP config           |
| 7.2 | Settings › Privacy › Delete all Murmur data                                          | The folder is emptied and saved keys are removed from Keychain |

## 8. Notch

Use the left Option key for ⌃⌥A: Right Option is the dictation hotkey.

| #    | Do                                                                                                         | Expect                                                                                                                                            |
| ---- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 8.1  | On a MacBook with a notch, hold Right Option                                                               | A black shape grows out of the notch: level bars on the left, the mode icon on the right, "Dictate · Esc to cancel" underneath                    |
| 8.2  | Move the pointer to an external display (or close the lid) and repeat                                      | A black pill about the size of a notch appears at the top center of that display and grows the same way. With nothing showing, no pill is visible |
| 8.3  | Press and release the hotkey quickly several times, watching the first frame                               | The surface appears on the key press with no delay, and a new press reverses a shrinking surface from its current size with no jump               |
| 8.4  | Release after speaking                                                                                     | The line under the notch changes to "Transcribing", then "Cleaning up"                                                                            |
| 8.5  | After an insert with changes, look at the notch                                                            | A short strip lists the first change. Hover it: it expands to the full list and stays open until the pointer leaves. It closes after about 6 s    |
| 8.6  | In TextEdit, hold Right Option + Shift, say "remind me to stretch in five minutes", let go and keep typing | The card hangs from the notch. TextEdit keeps focus and your typing continues there. The screen is not dimmed                                     |
| 8.7  | With the card showing, press plain Return in TextEdit                                                      | A new line in TextEdit; nothing is approved                                                                                                       |
| 8.8  | Press ⌃⌥A                                                                                                  | The card takes focus; its hint changes to "⌘Return to confirm · Esc to cancel"                                                                    |
| 8.9  | Press plain Return, then ⌘Return                                                                           | Return does nothing; ⌘Return approves. Focus goes back to TextEdit                                                                                |
| 8.10 | Trigger another approval, press ⌃⌥A, then Esc                                                              | It is cancelled and focus returns to TextEdit. Esc does nothing while the card isn't focused                                                      |
| 8.11 | Trigger an approval, then click outside the card                                                           | The card stays; nothing is cancelled                                                                                                              |
| 8.12 | Trigger an approval, then dictate while it waits                                                           | Listening takes over the notch and a "1 waiting" badge sits beside it with a slow, faint pulse. After the change report's 6 s, the card returns   |
| 8.13 | Trigger approvals for two calls in one request                                                             | The badge (or the card's footer) shows the count; they come one after another in order                                                            |
| 8.14 | Ask for a long task                                                                                        | A compact strip shows the step and step number when nothing else needs the notch; clicking it opens the side panel                                |
| 8.15 | Put Safari in full screen and dictate, then trigger an approval                                            | Both appear above the full-screen app                                                                                                             |
| 8.16 | Turn on Reduce motion and repeat 8.1 and 8.12                                                              | Surfaces cross-fade instead of growing; the badge does not pulse                                                                                  |
| 8.17 | Turn on Increase contrast                                                                                  | Cards get a thin light border                                                                                                                     |
| 8.18 | Turn on VoiceOver, then dictate and trigger an approval                                                    | VoiceOver says "Listening", then "Approval needed: …". Every button on the card has a label                                                       |
| 8.19 | Unplug the external display while a surface shows                                                          | It moves to the remaining screen's notch or pill                                                                                                  |

## 9. Updates

| #   | Do                                                                                    | Expect                                                                                                                               |
| --- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 9.1 | Settings › General                                                                    | Shows "Version 0.2.6" and a Check for Updates button                                                                                 |
| 9.2 | Click Check for Updates with no newer release published                               | "Murmur is up to date"                                                                                                               |
| 9.3 | After a newer release is published, wait up to a minute after launch (or click Check) | A notification and a menu item "Install Murmur x.y.z and Restart"                                                                    |
| 9.4 | Choose Install                                                                        | "Downloading…", then Murmur quits and reopens as the new version. macOS may ask for Accessibility and Input Monitoring again         |
| 9.5 | Install an update, then let Murmur relaunch                                           | It starts quietly in the menu bar. The setup window does not open                                                                    |
| 9.6 | If macOS dropped a permission with the update                                         | The menu shows "Finish setup…". Dictation works again after you turn the permission back on there. Setup still never opens by itself |

## Reporting

For each failure, record the step number, what you expected, and what happened. Add a screenshot and the Console.app log (filter: `Murmur`).
