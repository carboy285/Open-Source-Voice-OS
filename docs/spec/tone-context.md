# Context-aware tone

Output style adapts to the app the user is typing into (B-D4).

## Detection (D)

1. The shell reports the frontmost app's bundle id / executable name, its window title and, if available, the focused element's role.
2. The core maps it to a category using a built-in table that users can override in Settings. The table matches on id/executable, then on window-title keywords (for browsers: the site's domain from the title or the AX URL attribute where available).

| Category | Examples (matching heuristics, not exhaustive) |
|----------|----------|
| `email` | Mail, Outlook, browser tab on a webmail domain |
| `chat` | Slack, Teams, Discord, Messages, WhatsApp, LINE |
| `notes` | Notes, Obsidian, Notion, OneNote |
| `document` | Word, Pages, Google Docs |
| `code` | VS Code, Xcode, JetBrains IDEs, terminals |
| `general` | anything else |

## Style rules (D)

| Category | Rules |
|----------|-------|
| email | Full sentences; a greeting and sign-off only if the user dictated them; paragraphs on topic change |
| chat | Casual; no trailing period on single-sentence messages; keep emoji words as spoken; short |
| notes | Lists allowed and encouraged; terse fragments are OK |
| document | Formal punctuation; paragraphs |
| code | No polish stage; no auto-capitalization; no added trailing punctuation; spoken punctuation off |
| general | Neutral |

Tone never changes meaning, adds content or changes language. Users can turn tone adaptation off per category.
