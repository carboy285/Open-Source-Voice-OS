# MCP support

Users can add Model Context Protocol servers from the command line (B-A4).

## CLI (D)

| Command | Effect |
|---------|--------|
| `murmur add mcp <name> -- <command> [args…]` | add a stdio server |
| `murmur add mcp <name> --url <https-url> [--header K=V]` | add a streamable-HTTP server |
| `murmur add mcp <name> … --env K=V` | environment for stdio servers |
| `murmur list mcp` | list servers with their status and tool counts |
| `murmur remove mcp <name>` | remove |

- The config lives in `<config dir>/mcp.json` as `{servers: {<name>: {command, args, env} | {url, headers}, enabled}}`. Header and env values that look like secrets (`*TOKEN*`, `*KEY*`, `*SECRET*`, `Authorization`) are moved into the keychain and replaced by a reference (D).
- Names: `[a-z0-9-]{1,32}`.

## Client behavior (D)

- Connect on startup to enabled servers; reconnect with backoff (1 s → 60 s).
- `tools/list` on connect and on `notifications/tools/list_changed`.
- Tools are exposed to the agent as `mcp.<server>.<tool>`. The description is prefixed with the server name.
- Gating follows `approval-gate.md`: only `readOnlyHint: true` tools skip approval.
- Tool results: text content is joined; images are passed to vision models only; other content types are summarized as "[unsupported content]".
- Call timeout 60 s (setting).
- Server output is untrusted data and is labeled so in the model context.
