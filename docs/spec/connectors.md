# Connectors

Integrations with apps and services, toggled in Settings, browsable in a catalog (B-A1, B-A4).

## Connector contract (D)

A connector provides:

| Part | Description |
|------|-------------|
| id, name, description, icon | metadata; icons are Murmur's own or the provider's official brand assets used under their guidelines |
| auth | `none` · `oauth2-pkce` (authorize URL, token URL, scopes) · `api-key` · `local-path` |
| actions | a list of tools: name, description, input schema, side-effect flags (`readOnly`, `sends`, `books`, `modifies`, `destructive`) and a `summarize(input)` function for the approval preview |
| settings | optional fields, e.g. an Obsidian vault path |

- Secrets are stored in the OS keychain through the shell (macOS Keychain, Windows Credential Manager), never in SQLite or in files (D).
- Connectors only call official public APIs (D).
- Disabled connectors expose no tools to the agent (B-A4).

## Catalog (D)

| Connector | Auth | Actions | MVP status |
|-----------|------|---------|------------|
| Web search | none or api-key | search (ro), fetch page (ro) | implement |
| Files | local | search (ro), read metadata (ro), rename (modifies), move (modifies) | implement |
| Obsidian | local-path | search notes (ro), read (ro), create note (modifies), append (modifies) | implement |
| Reminders | none | create (modifies), list (ro), cancel (modifies) | implement |
| Gmail / Outlook mail | oauth2 | search (ro), draft (modifies), send (sends) | skeleton |
| Google Calendar / Outlook calendar | oauth2 | list events (ro), create event (books) | skeleton |
| Slack | oauth2 | search (ro), post message (sends) | skeleton |
| Notion | oauth2 | search (ro), create page (modifies) | skeleton |
| Linear | oauth2 | search issues (ro), create issue (modifies) | skeleton |
| Google Drive / Docs | oauth2 | search (ro), create doc (modifies) | skeleton |
| Messages (macOS) | local | send (sends) | open question: no public API; would need AppleScript and the Automation permission |

"Skeleton" means the metadata, schemas and summaries are complete and tested, while network calls are wired but need the user's own OAuth client id.

## MCP servers

Show in the same catalog under "Custom (MCP)"; see `mcp.md`.
