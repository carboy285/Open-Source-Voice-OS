# Writing a connector

A connector gives the agent a set of actions for one app or service. Each action declares what it changes, and Murmur's approval gate uses that to decide whether the user sees a preview first. This guide walks through the contract with a small example.

## The contract

A connector is an object of type `Connector` from `src/connectors/types.ts`:

| Field                 | What to put there                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `id`                  | Lower-case letters, e.g. `"todo"`. Tool names become `todo.<action>`.                      |
| `name`, `description` | Shown in Settings and to the model.                                                        |
| `icon`                | An icon id (`mail`, `calendar`, `note`, …). Each shell maps it to its own symbol.          |
| `auth`                | `none`, `api-key`, `local-path` or `oauth2-pkce` with authorize URL, token URL and scopes. |
| `actions`             | The tools. See below.                                                                      |
| `settings`            | Optional fields the user fills in, such as a folder or a client ID.                        |
| `status`              | `"ready"`, or `"skeleton"` when it needs the user's own OAuth client.                      |

Each action has:

| Field                   | Notes                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `name`, `description`   | The model reads the description to decide when to call it.                                                   |
| `inputSchema`           | JSON Schema for the input. Murmur validates every call against it.                                           |
| `effects`               | `{ readOnly: true }` for search, read and list. Otherwise `sends`, `books`, `modifies` and/or `destructive`. |
| `verb`                  | The preview button: `Send`, `Book`, `Save`, `Rename`, `Move`, `Delete` or `Run`.                             |
| `fields`                | Optional labels and editor types for the preview (`text`, `longtext`, `datetime`, `recipients`, `path`).     |
| `summarize(input, ctx)` | One line for the preview, written by your code from the input. Never let the model write it.                 |
| `run(input, ctx)`       | Does the work and returns text for the model. Throw an `Error` with a clear message on failure.              |

## How gating works

- An action with `readOnly: true` and no other flag runs without a prompt.
- An action with `sends`, `books`, `modifies` or `destructive` always shows a preview with Edit, Cancel and the verb button. Nothing a server, the model or a setting says can turn that off.
- `destructive` adds a red button and a second confirmation.
- An action that declares nothing is treated as gated.

## Example

```ts
import { clip, objectSchema, str, type Connector } from "./types.js";

export function todoConnector(store: { add(text: string): number; list(): string[] }): Connector {
  return {
    id: "todo",
    name: "To-do list",
    description: "Add items to a local to-do list and read it back.",
    icon: "note",
    auth: { type: "none" },
    status: "ready",
    actions: [
      {
        name: "list",
        description: "List open to-do items.",
        inputSchema: objectSchema({}),
        effects: { readOnly: true },
        summarize: () => "List to-do items",
        async run() {
          return store.list().join("\n") || "Nothing to do.";
        },
      },
      {
        name: "add",
        description: "Add one to-do item.",
        inputSchema: objectSchema({ text: { type: "string", minLength: 1 } }, ["text"]),
        effects: { modifies: true },
        verb: "Save",
        fields: { text: { label: "To-do" } },
        summarize: (input) => `Add "${clip(str(input.text))}" to your to-do list`,
        async run(input) {
          return `Added item ${store.add(str(input.text))}.`;
        },
      },
    ],
  };
}
```

Register it in `builtinConnectors()` in `src/connectors/index.ts`. Users turn it on in Settings › Connectors; disabled connectors expose no tools.

## Secrets and settings

- Read settings from `ctx.settings` (what the user entered for your connector).
- Read and write secrets with `ctx.secrets`, which is backed by the system keychain. Name keys `connector/<id>/<what>`. Never put a secret in settings, files or the database.
- Use `ctx.fetch` for HTTP so tests can replace it, and call only official public APIs.

## OAuth connectors

Set `auth` to `oauth2-pkce` with the provider's authorize URL, token URL and scopes, and add a `clientId` setting. When the user clicks Connect, Murmur runs the PKCE flow with a loopback redirect to `http://127.0.0.1:53682/callback` and stores the tokens in the keychain. Register that redirect URI with your OAuth client. In your actions, call the API through `apiJson(ctx, { id, name, tokenUrl }, url, init)` from `src/connectors/skeletons/http.ts`; it adds the bearer token and refreshes it when it expires.

Some providers (Slack and Notion, for example) also require a client secret at the token endpoint. Those connectors need a small change to send it, kept in the keychain.

## Testing

Add tests in `tests/connectors.test.ts`:

- `summarize` returns the line you expect for a realistic input
- `run` works against a temporary folder or a fake `fetch` (`tests/fakes/connectors.ts`)
- `classify()` gates the actions you expect

Run `npm test` before opening a pull request.
