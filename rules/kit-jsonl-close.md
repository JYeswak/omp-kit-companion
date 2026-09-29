---
description: "Kit B2: direct JSONL closes must carry a substantive close_reason"
condition:
  - '(?i)(?:^|\n)(?=[^\n]*"status"\s*:\s*"closed")(?!(?:[^\n]*"close_reason"\s*:\s*")(?:[^"\\\n]|\\.)*(?:\b(?:commit|sha)\s+[0-9a-f]{7,40}\b|\b(?=[0-9a-f]{0,39}[a-f])[0-9a-f]{7,40}\b|\b\d+\s+(?:tests?\s+)?passed\b|\bledger\s+row\s+[a-z0-9][a-z0-9._:-]*|\b[a-z][a-z0-9_./-]*(?:[ \t]+(?:[^"\\\n]|\\.)*?)?[ \t]+->[ \t]*[^\s"\\]))(?:[^"\\\n]|"(?:[^"\\\n]|\\.)*")*\}[ \t]*(?:\r?\n|$)'
scope: "tool:edit(**/.beads/issues.jsonl), tool:write(**/.beads/issues.jsonl)"
interruptMode: always
---
**Blocked before it was written.** The edit or write you were composing closes a bead without a substantive `close_reason`. It was cut off while you wrote it; the last visible tool call is not the blocked one. The file was not changed. Do not re-issue the same edit.

You are marking a bead closed in .beads/issues.jsonl without cited evidence. Include a command plus its output, a 7–40-character hexadecimal SHA containing a letter (label all-digit SHAs with `commit` or `sha`), a numeric pass count, or `ledger row <id>` in the same object's `close_reason`, and include `closed_at`. Field order does not matter. Length alone is not evidence. This is a syntax check; it cannot verify that a cited command ran or that a result is true.
