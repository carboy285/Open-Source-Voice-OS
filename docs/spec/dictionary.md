# Custom dictionary

Learns names, product names and acronyms and writes them the way the user wants (B-D3).

## Entry

| Field | Description |
|-------|-------------|
| id | integer |
| written | canonical spelling, e.g. "PostgreSQL" (required) |
| spoken | zero or more variants the STT tends to produce, e.g. "postgres q l", "postgres sequel" |
| kind | `name` · `product` · `acronym` · `term` |
| case_sensitive | default true for acronyms, false otherwise |
| source | `manual` · `learned` |
| uses | count of applications |
| created_at / updated_at | timestamps |

(D)

## Matching (D)

- Whole-word, case-insensitive match of any `spoken` variant or of `written` itself; the longest match wins.
- The replacement uses `written` exactly.
- Entries are also passed to the STT provider as a vocabulary hint (whisper "initial prompt" style, ≤ 200 tokens, most-used first) and to model polish as "preserve these spellings".

## Learning (D)

- After insertion, the shell watches the inserted span for 30 s. If the user edits a single word within it, the pair (inserted word → corrected word) is a candidate.
- The same correction twice in 7 days → a suggested entry, shown in the change report as `dictionary_added` with Undo. It is never added silently without the report.
- Users can turn learning off.

## Edge cases

- Conflicting entries for the same spoken variant: the most recently updated one wins, and Settings shows a warning.
- An entry is never applied inside a URL, email address or code span (backticks).
