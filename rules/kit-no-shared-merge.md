---
description: "Never merge or rebase in a shared checkout; use explicit remote pull only when targeting shared checkout"
condition:
  - '(?i)\bgit(?<!\becho[^;\n]{0,64})(?<!\bprintf[^;\n]{0,64})(?<!\b(?:omp-kit send|ntm send|br comments?)[^;&|\n]{0,160})(?<!var\/agent-tmp[\s\S]{0,64})(?![\s\S]{0,64}var\/agent-tmp)(?:\s|\\{1,3}n)+(?:merge|pull|rebase)(?!(?:-base|-tree)\b)(?=[\s;&|)"\x60]|\\n)'
scope: tool:bash
interruptMode: never
---
Don't merge or rebase in a shared checkout: it moves other agents' uncommitted work (a peer's dirty files can refuse your merge, or your merge can swallow theirs). An explicit `git pull <remote> <ref>` targeting shared checkout is also prohibited; `git pull` without explicit targets may resolve configured upstreams and is outside this rule's detection contract. Integrate origin with `python3 ~/Developer/omp-kit/scripts/git_converge.py --repo <checkout> --push` instead: it brings origin into the shared `main` path by path without moving peers' staged or uncommitted work, and publishes `main` itself. Commit your own paths on `main` with `git commit --only -- <paths>`; never push a private-index candidate, which splits the repo into two histories. Ordinary git inside scratch clones under var/agent-tmp is fine.
