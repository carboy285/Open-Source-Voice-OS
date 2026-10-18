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
