---
description: "AGENTS.md one rule: a step you can satisfy by believing you did it is not a step"
condition:
  - '(?i)\b(all|the) tests (should )?(now )?pass(ed)?\b'
  - '(?i)\bshould (now )?(work|pass|be fixed)\b'
  - '(?i)\b(this|that|it) (should|will) fix\b'
  - '(?i)\bis now (fixed|working|completed?|done)\b'
scope: "text"
interruptMode: prose-only
---
**Interrupted.** Your last message claimed a result without quoting command evidence, and it was cut off at that claim. Do not repeat the claim unchanged.

You are claiming a result in prose. docs/definition-of-done.md: done needs command evidence. Before you assert it, run the command that proves it and quote the command and the relevant output lines. If you cannot run it, say UNVERIFIED and name the command that would verify it.
