# Privacy

| Guarantee | Source | How Murmur meets it |
|-----------|--------|---------------------|
| No audio stored in the cloud | B-P1 | Default STT is local. If the user picks a cloud STT provider, audio goes to that provider under the user's own key, and Settings warns about that provider's retention. Murmur never stores audio anywhere, locally or remotely (D) |
| No training on user data | B-P2 | Murmur has no servers and collects nothing to train on. Cloud LLM/STT providers are the user's choice; Settings links to their data policies (D) |
| Local transcripts only if opted in | B-P3 | `history.saveTranscripts` defaults to false (`storage.md`) |
| Anonymous, opt-in diagnostics | B-P4 | Default off. When on: an app version, OS version, a random install id rotated every 30 days, and counters (dictations, agent tasks, error codes, latency buckets). **Never** text, audio, app names, file names or connector data. The exact payload is shown in Settings before opting in. The endpoint is configurable and empty by default (no Murmur-operated server exists yet) (D) |

Other rules (D):
- Screen context is captured only on hotkey press, used for that request, and not stored.
- Connector tokens live in the OS keychain.
- No network call happens without a configured provider; offline use with local STT + local LLM works fully.
