---
description: "Never merge or rebase in a shared checkout; use explicit remote pull only when targeting shared checkout"
condition:
  - '(?i)\bgit(?<!\becho[^;\n]{0,64})(?<!\bprintf[^;\n]{0,64})(?<!var\/agent-tmp[\s\S]{0,64})(?![\s\S]{0,64}var\/agent-tmp)(?:\s|\\{1,3}n)+(?:merge|pull|rebase)(?!(?:-base|-tree)\b)(?=[\s;&|)"\x60]|\\n)'
scope: tool:bash
interruptMode: never
---
Don't merge or rebase in a shared checkout: it moves other agents' uncommitted work (a peer's dirty files can refuse your merge, or your merge can swallow theirs). An explicit `git pull <remote> <ref>` targeting shared checkout is also prohibited; `git pull` without explicit targets may resolve configured upstreams and is outside this rule's detection contract. Land from a private index instead: GIT_INDEX_FILE=<scratch>.idx git read-tree origin/main, apply only your hunk --cached, write-tree, commit-tree -p origin/main with the bead id, push the sha to its branch. Ordinary git inside scratch clones under var/agent-tmp is fine.
