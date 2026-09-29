---
description: "Kit B2: a close reason that names no command, SHA, pass count, or ledger row is not evidence"
condition:
  - '(?i)\b(?:br|bd)\s+close\b(?:\s+(?!(?:\\?["''])?(?:--reason|-r)(?:\\?["''])?(?=[\s=]))(?:[^\s"''\\;&|]|''[^'']*''|\\"(?:[^"\\]|\\\\(?:\\.|[^\\"])|\\[^"\\])*\\")+)*?\s+(?:\\?["''])?(?:--reason|-r)(?:\\?["''])?(?:\s+|=)(\\?["''])(?![^"''\\]*(?:\b(?:commit|sha)\s+[0-9a-f]{7,40}\b|\b(?=[0-9a-f]{0,39}[a-f])[0-9a-f]{7,40}\b|\b\d+\s+(?:tests?\s+)?passed\b|\bledger\s+row\s+[a-z0-9][a-z0-9._:-]*|\b[a-z][a-z0-9_./-]*(?:[ \t]+[^"''\\]*?)?[ \t]+->[ \t]*[^\s"''\\]))[^"''\\]+\1'
  - '(?i)(?:(?<="command"\s*:\s*")|(?<=[;&|(])|(?<=\\n))\s*(?:(?:command|exec)\s+|(?:timeout|gtimeout)\s+(?:[^\s"''\\;&|]+\s+)*?)?(?:[A-Za-z0-9_./-]+/)?(?:br|bd)\s+close\b(?:\s+(?!(?:\\?["''])?(?:--reason|-r)(?:\\?["''])?(?=[\s=]))(?:[^\s"''\\;&|]|''[^'']*''|\\"(?:[^"\\]|\\\\(?:\\.|[^\\"])|\\[^"\\])*\\")+)*?\s+(?:\\?["''])?(?:--reason|-r)(?:\\?["''])?(?:\s+|=)(?!(?=[0-9a-f]{0,39}[a-f])[0-9a-f]{7,40}(?=[\s;&|"]|\\n))[^\s"''\\;&|]+(?=[\s;&|"]|\\n)'
scope: "tool:bash"
interruptMode: always
---
**Blocked before it ran.** The `bash` call you were in the middle of writing contained `br close` with a `--reason` that names no evidence. It was cut off while you wrote it, so it is not in your transcript: the last `bash` call you can see ran normally and is not the blocked one. The blocked call did not execute. Do not re-issue it unchanged.

The close has a reason, and the reason still has no evidence. "done", "fixed", "resolved, tests pass", and "all tests pass" are not evidence.

Re-run the acceptance command. Close with a reason that contains a command and its output, a commit SHA you just created, or a ledger row. Do not invent any of those. If you did not run the command, leave the bead open and say UNVERIFIED.

Accepted citation shapes are a 7–40-character hexadecimal SHA containing a letter, an explicit `commit <sha>` or `sha <sha>` (also permits all-digit SHAs), a numeric pass count, `ledger row <id>`, or a command followed by `->` and nonempty output. Bare `passed`, an unlabelled numeric date, the word `ledger`, and an arrow without output do not cite evidence. This is a syntax check, not verification that the cited result exists.
