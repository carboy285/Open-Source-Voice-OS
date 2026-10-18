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

You also need a speech model:

```sh
brew install whisper-cpp
curl -L -o ~/ggml-base.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin
```

## 1. Install

| #   | Do                                                | Expect                                                                                                            |
| --- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1.1 | Open the `.dmg`                                   | A window with Murmur and an Applications shortcut                                                                 |
| 1.2 | Drag Murmur to Applications, eject the disk image | —                                                                                                                 |
| 1.3 | Right-click Murmur in Applications › Open › Open  | The build is unsigned, so macOS warns once. If it refuses, use System Settings › Privacy & Security › Open Anyway |
| 1.4 | Look at the menu bar                              | A Murmur icon appears. There is no Dock icon                                                                      |

## 2. Onboarding and permissions

| #   | Do                                                     | Expect                                                                  |
| --- | ------------------------------------------------------ | ----------------------------------------------------------------------- |
| 2.1 | First launch                                           | The onboarding window opens, in Japanese if your Mac is set to Japanese |
| 2.2 | Grant Microphone                                       | The system prompt appears; the row turns to granted without restarting  |
| 2.3 | Grant Accessibility (the button opens System Settings) | After you switch Murmur on, the row updates within a few seconds        |
| 2.4 | Skip Screen Recording                                  | The app keeps working; agent screenshots are simply not used            |
| 2.5 | Close onboarding, then reopen it from the menu         | The permission status is still correct                                  |

## 3. Dictation

First, in Settings › Dictation, pick `whisper-cli` (`/opt/homebrew/bin/whisper-cli`; the picker opens in that folder) and `~/ggml-base.bin`. The field shows the saved path.

If the whisper-cli choice doesn't stick (the field goes back to `whisper-cli`, or a red message appears under it):

- Type the full path, `/opt/homebrew/bin/whisper-cli`, into the field instead. It saves as you type.
- Or leave it as `whisper-cli`. Murmur looks in `/opt/homebrew/bin`, `/usr/local/bin` and then PATH, so a Homebrew install is found either way.
- To check what was saved: `sqlite3 ~/Library/Application\ Support/Murmur/murmur.db "select * from settings where key like 'stt.%'"`. Note any red message in your report.

| #    | Do                                                                                    | Expect                                                                                      |
| ---- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 3.1  | Click into TextEdit. Hold Right Option, say "um so the meeting is uh at noon", let go | "So the meeting is at noon." appears at the cursor                                          |
| 3.2  | Watch the screen while you press                                                      | The listening indicator appears the instant you press the key, with no delay                |
| 3.3  | Check the change card after inserting                                                 | It lists the removed fillers and disappears after a few seconds                             |
| 3.4  | Tap Right Option very briefly                                                         | Nothing is inserted (a press under 300 ms counts as accidental)                             |
| 3.5  | Hold, start speaking, press Esc                                                       | Listening is cancelled and nothing is inserted                                              |
| 3.6  | Say "first buy milk second call Ana third book flights" in Notes                      | A three-item list                                                                           |
| 3.7  | Dictate into Slack or Messages, then into Mail                                        | Chat output is casual with no trailing period; Mail gets full sentences                     |
| 3.8  | Dictate into a password field                                                         | Murmur refuses to insert                                                                    |
| 3.9  | Dictate into a browser text box and into VS Code                                      | Text arrives (by paste if direct insertion fails), and the clipboard is restored afterwards |
| 3.10 | Speak Japanese                                                                        | Japanese text with 。, no added spaces                                                      |
| 3.11 | Select text, hold Right Option + Command, say "make this more formal"                 | The selection is rewritten (needs a model in Settings › Agent)                              |

## 4. Agent and the approval gate

In Settings › Agent, add an Anthropic API key or a local OpenAI-compatible server (e.g. LM Studio or Ollama).

| #    | Do                                                                       | Expect                                                                                                                                   |
| ---- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1  | Hold Right Option + Shift, say "remind me to stretch in two minutes"     | An approval window shows the reminder and its time, with Edit, Cancel and Save                                                           |
| 4.2  | Press Cancel                                                             | Nothing is created; the reply says you cancelled                                                                                         |
| 4.3  | Repeat, press Edit, change the text, Save, then approve                  | The preview shows your edited text before you approve; the reminder uses it                                                              |
| 4.4  | Wait two minutes                                                         | A notification fires with Snooze and Done                                                                                                |
| 4.5  | Repeat 4.1, then press Esc or close the window                           | Treated as Cancel                                                                                                                        |
| 4.6  | Ask to rename a file in a test folder (enable the Files connector first) | A preview appears before anything changes                                                                                                |
| 4.7  | Ask something read-only: "what reminders do I have"                      | It answers with no approval prompt                                                                                                       |
| 4.8  | Ask a multi-step task                                                    | It moves to the side panel, which slides in from the screen edge. You can keep typing elsewhere. A notification arrives when it finishes |
| 4.9  | Cancel a running task from the side panel                                | It stops before the next step                                                                                                            |
| 4.10 | Open History in the side panel                                           | Past tasks are listed; the transcript shows "—" unless Keep transcripts is on                                                            |

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
| 6.5 | Turn on VoiceOver, tab through the approval window                | Every control is labeled and reachable by keyboard   |

## 7. Privacy

| #   | Do                                                                                   | Expect                                                         |
| --- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| 7.1 | Dictate several times, then run `find ~/Library/Application\ Support/Murmur -type f` | No audio files, only the database and the MCP config           |
| 7.2 | Settings › Privacy › Delete all Murmur data                                          | The folder is emptied and saved keys are removed from Keychain |

## Reporting

For each failure, record the step number, what you expected, and what happened. Add a screenshot and the Console.app log (filter: `Murmur`).
