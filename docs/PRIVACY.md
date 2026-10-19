# Privacy

Murmur runs on your computer and has no servers of its own. This page lists what it keeps, where, and for how long.

## Microphone

The microphone is on while you hold the hotkey, plus a quarter second after you let go so the last word isn't cut off. After a recording it stays on for 20 more seconds so the next press starts instantly; macOS shows its microphone indicator during that time. While it is warm, Murmur keeps only the last 0.3 seconds in memory, so a word spoken right as you press the key is captured. Nothing from that window is kept unless you press the hotkey, and it is never written to disk.

## Updates

Murmur checks GitHub Releases for a newer version shortly after launch and every 6 hours (turn this off in Settings › General). The check sends no data about you beyond what any web request carries (your IP address and Murmur's version in the User-Agent). Updates install only when you choose to, and only after the download matches the checksum published with the release.

## What Murmur stores

| Data                       | Where                                        | When                                                                                                                                                  |
| -------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Audio                      | Memory only                                  | Dropped as soon as the transcript exists, or when you dismiss an error. Never written to disk. See "Microphone" below for the warm-up window.         |
| Dictation history          | SQLite database                              | Time, app category, word count and duration. The text itself only if Keep transcripts is on. Kept 30 days.                                            |
| Agent tasks                | SQLite database                              | Status, steps (tool name, a one-line summary, your approval decision) and the reply. The spoken request only if Keep transcripts is on. Kept 30 days. |
| Dictionary and corrections | SQLite database                              | Words you add, and word corrections for 7 days so Murmur can suggest dictionary entries.                                                              |
| Reminders                  | SQLite database                              | Until they fire or you cancel them.                                                                                                                   |
| Keys and tokens            | macOS Keychain or Windows Credential Manager | Until you remove them or delete all data.                                                                                                             |
| MCP servers                | `mcp.json` in the data folder                | Secret values are replaced by keychain references.                                                                                                    |

The data folder is `~/Library/Application Support/Murmur` on macOS and `%APPDATA%\Murmur` on Windows.

## Screen context

When you hold the agent key, the shell reads the selected text, the text under the pointer and the focused field (up to 4,000 characters each), plus the app name and window title. It is used for that one request and not stored. Murmur tells the model that this text is data, not instructions.

## Network

Murmur makes a network call only to a provider you set up:

- your model provider for the agent and for optional text polish
- your search provider for web search
- services you connect (Gmail, Slack and so on) with your own OAuth client
- Composio (`backend.composio.dev`), only if you add a Composio API key in Settings › Apps
- MCP servers you add

Speech recognition runs locally. The only speech-related network traffic is downloading a model when you click Download: the file comes from huggingface.co (ggml-org/parakeet-GGUF), is checked against the SHA-256 Hugging Face publishes for it, and is stored in `models/` next to the database. With a model downloaded and a local model server for the agent, Murmur works fully offline.

## Diagnostics

Anonymous diagnostics are off by default. The setting exists, but this version has no diagnostics endpoint and sends nothing. If one is added, it will only ever carry the app version, OS version, a random install ID rotated every 30 days and counters, never text, audio, app names, file names or connector data, and Settings will show the exact payload first.

## Deleting your data

- Turning off Keep transcripts offers to delete the text already saved.
- Settings › Privacy › Delete all Murmur data removes the database, Murmur's keychain entries and the MCP config. Downloaded speech models hold nothing about you and stay; delete them in Settings › Dictation.
- Uninstalling the app does not delete the data folder; use Delete all first if you want it gone.

## Signing in with ChatGPT

If you choose "ChatGPT subscription" for the agent, Murmur asks OpenAI for a one-time code, you enter it on OpenAI's page, and Murmur keeps the resulting sign-in in your keychain (macOS Keychain or Windows Credential Manager), the same place an API key goes. Your text then goes to OpenAI under your ChatGPT account, and your plan's usage limits apply. Signing out, or "Delete all data", removes the stored sign-in. Murmur does not read the files of any other app, including the Codex command-line tool.

## Connecting apps through Composio

Settings › Apps lets you connect Gmail, Google Calendar, Slack, Notion and other apps through [Composio](https://composio.dev). You paste your own Composio API key; Murmur keeps it in your keychain. Signing in to an app happens on that app's page in your browser, and Composio holds the resulting access, not Murmur. Murmur sends Composio a random id for this install, so connections are kept apart from other people's using the same key.

When the agent uses a connected app, the request and the app's reply (for example the emails it read) pass through Composio's servers, and then on to your model provider. Composio's own terms and privacy policy apply to that traffic. Each app has a switch ("Agent can use it") and a "Read only" option that hides every tool that sends or changes something. Anything that sends, books, changes or deletes still shows you a preview first, and Murmur decides what counts as a change from the tool's name, so a tool it doesn't recognise is treated as a change. Disconnecting an app in Settings removes it from Composio; removing the key stops Murmur from reaching it. "Delete all data" removes the key.

## Mail, Calendar and Reminders on a Mac

On a Mac, three connectors (off until you turn them on in Settings › Connectors) let the agent use the apps you already have. Calendar and Reminders go through Apple's EventKit; Mail is read with a short AppleScript. macOS asks you to allow each one the first time it is used, and you can take that back in System Settings › Privacy & Security. Nothing leaves your Mac for these, except that what the agent reads is sent to your model provider so it can summarize it. The Mail connector can read your inbox and open a draft in Mail; it cannot send. Its search looks at the latest 200 messages.

## Conversation memory and spoken replies

The agent remembers the conversation so a follow-up like "move it to 4" makes sense: your earlier requests, its replies, and a short log of which tools ran. This is kept in memory only. It is not written to disk, and it is forgotten after 30 quiet minutes, with New chat, or when Murmur quits. While it lasts, the earlier turns are sent to your model provider with each new request, as part of the request. Spoken replies use your Mac's own voices; the text is not sent anywhere for that.

## Circle to Ask and pictures of your window

When you circle something (or switch on "Include a picture of my window"), Murmur takes a picture of that area or window with macOS Screen Recording, which you allow in System Settings. The words in it are read on your Mac. The picture and those words go to your own AI provider with your question, and nowhere else. Pictures are held in memory for that one request: they are not saved, and the chat memory keeps only a note that a picture was attached. A model that cannot see images gets the words alone. Murmur never watches the screen in the background; it looks only when you circle, or when you have asked it to include your window.

## Coding agents

If you switch on Codex, Claude Code or OpenCode in Settings, Murmur can start them in a folder you name and show their questions in the notch. Murmur runs the agent program already installed on your Mac and talks to it on your computer only. Your task and the agent's messages go to Murmur's own screen; whatever the agent itself sends to its provider is between you and that provider, as when you run it yourself. Murmur never reads the agent's sign-in or keys. Nothing is allowed by default: no answer, a timeout or closing a card is a "no", and a risky command needs a second yes. Murmur never starts agents that act for you in the outside world (such as Cue).

## Using your computer

The Computer connector (on by default, Settings › Connectors) lets the agent open files, links and apps, and on a Mac look at an app's window, press buttons, type and choose menus. Opening, quitting, clicking, typing and key presses each show a preview first and happen only if you approve. Two things are not previewed: looking for a file by name (Spotlight, in your home folder) and reading the names of the buttons and fields in an app's front window. Both are done on your Mac; what they return goes to your own AI provider as part of the request, like the words Murmur reads for Circle to Ask. Password fields are never read or typed into. Murmur's own windows, Terminal-style apps, password managers and System Settings are off limits, so the agent cannot approve its own previews or change your permissions. Nothing here is sent to Murmur or to anyone but your chosen provider.

## Web search through Composio

With a Composio key in Settings › Apps, the agent can search the web with Composio's search tools, which need no sign-in. Your search words go to Composio's servers and to the search services it uses, the same as for your connected apps. Without a Composio key, search uses the provider you chose in Settings › Connectors › Web search, or none.
