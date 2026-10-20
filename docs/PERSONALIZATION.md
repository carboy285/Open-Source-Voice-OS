# Voice tools and guided setup

Murmur now includes six additions on macOS and Windows:

- **Voice shortcuts:** Settings › Personalize. Add a spoken phrase and either saved text or an AI task. Say the complete phrase in dictation mode. Text is inserted exactly as saved unless translation is enabled; task shortcuts run through the existing agent and approval settings. Shortcuts are deliberately saved content, independent of the transcript-history preference.
- **Live transcription:** Settings › Dictation › Show live transcription. Every three seconds, a local preview transcribes up to the most recent 15 seconds of audio. It is provisional text shown in Murmur; releasing the key transcribes and inserts the full recording. Releasing the key cancels any unfinished preview before final recognition. Preview text is neither saved nor sent to an AI provider.
- **Quick corrections:** Within two minutes of a successful dictation, say “change Tuesday to Thursday” or “undo my last dictation”. The old phrase must occur exactly once. The native shell verifies the same field, unchanged text and unchanged cursor before replacing the dictated span. Apps without readable accessibility text cannot use this feature; select text and use voice edit instead. These command phrases currently use English. Corrections are not saved as extra history entries.
- **Writing profiles:** Settings › Personalize. Choose Work, Friends, Concise, or create your own profile. App assignments take precedence over the default profile. Profiles use the configured AI provider, preserve meaning and language, and retain existing polish limits and fallback behavior. Code fields bypass polish. Removing the selected profile falls back to normal app-aware writing.
- **Translation:** Settings › Personalize › Dictation translation. Choose Translate dictation and a target language. This is an explicit mode for dictated text and text shortcuts. It requires the configured AI provider and reports a failure rather than inserting untranslated text. Ordinary dictation retains its existing language-preservation rules. AI task requests are not translated.
- **Setup test:** The new introduction leads through access, a local speech model, and a practice area. The microphone test uses the actual speech and cleanup pipeline without inserting text, starting tasks or storing transcripts. Recording stops automatically after 20 seconds. A separate practice field tests the real hotkey and insertion route. Practice is optional once the required permissions and model are ready. Screen capture and an AI provider are introduced as optional extras.

## Protocol additions

- `dictation.preview { audio, sampleRate }` → `{ text }`: at most one preview at a time; disabled previews, oversized audio and stale results return empty text.
- `setup.practice { audio, sampleRate }` → `{ text }`: safe local speech practice. Also accepts `transcript` for testing.
- Shell method `text.replaceRecent { expected, replacement }` → `{ ok }`: conditional replacement of the last inserted span, with native field and caret checks.

Personalization is persisted through `settings.get` / `settings.set`. The new keys are `voice.shortcuts`, `writing.profiles`, `writing.activeProfile`, `dictation.livePreview`, `dictation.outputMode` and `dictation.targetLanguage`. Collections and language/mode values are validated before saving.

## Manual acceptance checks

1. Run setup in English and Japanese. Check long text, keyboard navigation, scrolling and status changes after returning from system permission settings.
2. Download a speech model; verify progress, cancel/retry behavior, and that Continue stays unavailable until a model is selected.
3. Test a short microphone recording and silence. Confirm practice creates no history entry. Dictate into the practice field using the hotkey.
4. Add, edit and remove a text shortcut and task shortcut. Test punctuation/case, non-exact phrases and duplicate phrases. Verify a task still uses normal approvals.
5. Dictate a sentence; replace one word, then undo it. Repeat after moving the caret, modifying the field, switching apps, waiting two minutes and using a password field: no unrelated text should change.
6. Enable live preview; speak for more than 15 seconds, then release. Verify complete final text, no duplicate insertion, and no late preview after cancellation or a new recording.
7. Select a writing profile, assign another to an app, and verify the assignment wins. Check code fields and model failures retain their usual behavior.
8. Translate a dictation and text shortcut. Test missing AI credentials and a provider error: source text must not be inserted as a purported translation. Turn translation off and verify ordinary dictation preserves language.

Native insertion, microphones and permission prompts require testing on their respective operating systems. Compilation and fake-provider tests do not establish that every third-party app exposes usable accessibility text.
