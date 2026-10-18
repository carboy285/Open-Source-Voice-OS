# Contributing to Murmur

Thanks for helping. This page covers setup, checks, and the rules every change follows.

## Setup

```sh
npm ci
npm test
```

Node 22 is required (Murmur uses `node:sqlite`). The native shells need Xcode 15+ (macOS) or the .NET 8 SDK (any OS can compile the Windows project; it runs only on Windows).

## Before you open a pull request

Run the same checks as CI:

```sh
npm run lint && npm run format:check && npm run typecheck && npm test && npm run build
```

If you touched a shell, also run `swift build` in `native/macos` or `dotnet build native/windows/Murmur.sln`.

## Rules

1. **Clean room.** Murmur's behavior comes only from `docs/spec/` and this repository. Do not copy, decompile, capture or imitate any other voice product: no binaries, network traffic, prompts, UI copy, icons or sounds. Write everything new. Read `docs/spec/LEGAL.md` first.
2. **The approval gate is not optional.** A tool that sends, books, modifies or deletes must declare it, and it must go through `ApprovalGate`. Tests in `tests/gate.test.ts` must keep passing. MCP tools are gated unless `readOnlyHint` is exactly `true`.
3. **Privacy.** Never write audio to disk. Store transcript text only when `history.saveTranscripts` is on. Keep secrets in the keychain through `SecretStore`.
4. **Strings.** Every UI string goes into both `src/i18n/en.json` and `src/i18n/ja.json` with the same key. Japanese copy should read like natural Japanese UI text, not a literal translation.
5. **Style.** Small modules, short doc comments, no over-commenting. Prettier and ESLint decide formatting.
6. **Tests.** New behavior needs a test in `tests/`. Fakes live in `tests/fakes/`.

## Writing style for docs and UI

Plain, specific and active. Lead with the point, and use real names, numbers and commands. UI strings stay short: "Hold Right Option to dictate", "Send email to ana@example.com?".

## Commits

Use clear messages that say what changed and why. One logical change per commit.

## License

By contributing you agree that your contributions are licensed under the Apache License 2.0.
