---
description: "Route shared-checkout merge, pull, and rebase attempts to owner-bound landing"
condition:
  - '(?i)\bgit(?<!\becho[^;\n]{0,64})(?<!\bprintf[^;\n]{0,64})(?<!\b(?:omp-kit send|ntm send|br comments?)[^;&|\n]{0,160})(?<!var\/agent-tmp[\s\S]{0,64})(?![\s\S]{0,64}var\/agent-tmp)(?:\s|\\{1,3}n)+(?:merge|pull|rebase)(?!(?:-base|-tree)\b)(?=[\s;&|)"\x60]|\\n)'
scope: tool:bash
interruptMode: never
---
Do not merge, pull, or rebase in a shared checkout: each can move other agents' uncommitted work. This rule covers both bare and explicit-target `git pull`. Publish only reserved paths with owner-bound `omp-kit land --paths <paths> --message <message> --apply --yes`; do not handcraft private-index candidates or push candidate SHAs. When the shared local main must be reconciled, use `python3 ~/Developer/omp-kit/scripts/git_converge.py --repo <checkout> --push` and honor its safety refusals. Ordinary git inside scratch clones under `var/agent-tmp` is fine.
Plumbing skips the commit hooks, so before `commit-tree`: write the message to a msgfile and run `GIT_INDEX_FILE=<same idx> git hook run commit-msg -- <msgfile>`, exit 0 required (this is the verification-level gate `commit-tree` would otherwise bypass).
