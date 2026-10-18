# Legal and provenance record

Recorded 2026-10-18.

## Terms of use

- The brief says the project owner reviewed the original product's Terms of Use and found that they permit analysis.
- **Not independently verified.** The terms page and the public docs site could not be reached from the build environment (DNS resolution failed), so no clause was quoted or recorded here.
- Because of that, the project owner decided on 2026-10-18 to **skip binary analysis entirely**. This means the terms clause is not needed for anything this project did.

## What was and was not used

| Input | Used? |
|-------|-------|
| Public product behavior as summarized in the project brief | Yes, behavior only |
| Owner's black-box notes from their own licensed trial | Only if added to `OBSERVATIONS.md` (none so far) |
| Application binaries, installers, disk images | **No.** None were present or opened |
| Decompiled code, disassembly, strings, symbol names | **No** |
| Network traffic, APIs, servers of the original vendor | **No** |
| Prompts, models, weights, icons, sounds, UI copy | **No** |
| Credentials, keys, tokens | **No** |

## Clean-room rules for Murmur

1. All code, prompts, UI text, icons and sounds are written new for Murmur.
2. Murmur uses its own name and branding. It is not affiliated with, endorsed by or connected to WakoAI, Inc. or its products, and must not suggest otherwise.
3. Contributors must not add material taken from the original product or from analysis of it. Any future reverse-engineering work needs a new, written decision recorded here, kept separate from implementers.
4. Third-party integrations use official public APIs and OAuth flows under each provider's developer terms.

## Open legal flags

- The terms clause was never captured. If binary analysis is ever reconsidered, record the clause text, URL and date here first.
- The name "Murmur" has not had a trademark search. Do one before a public release.
