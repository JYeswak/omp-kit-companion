---
condition: '\bunsafe\b'
scope: tool:edit(*.rs), tool:write(*.rs)
interruptMode: never
---
**This edit adds `unsafe` to a `.rs` file.** Load the two exorcists. Do not invent a `jsm search` query — the natural one is empty.

Skills:
- `rust-unsafe-code-exorcist`
- `rust-undefined-behavior-exorcist`

Working queries (measured 2026-09-20, `jsm 0.2.0`):
```
jsm search miri
jsm search 'undefined behavior'
```
Those return the UB exorcist in top 3. This query returns **count=0**:
```
jsm search 'rust unsafe undefined behavior miri'
```
`jsm search 'rust unsafe'` returns the unsafe exorcist and **misses** the UB exorcist.

BIND-BY-CONSTRUCTION: the trigger *is* the gap (`unsafe` in a `.rs` edit/write). The injection is a skill name plus a working query, not doctrine. R64 killed file-type doctrine because type and clause were independent (1 bind / 75 edits). Here they are the same fact.

An older, private multi-repository sample counted 476 commits matching `git log --since='60 days ago' -S unsafe --pretty=format:%H -- '*.rs'`. This is an archival observation, not a current/public prevalence estimate; rerun a representative sample before using the 50-commit retirement floor.

RETIRE when a 30-day window of `.rs` edits adding `\bunsafe\b` drops below 50, or when `jsm search 'rust unsafe undefined behavior miri'` returns both exorcists in top 3.
