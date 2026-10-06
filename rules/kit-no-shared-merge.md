---
description: "Never merge, pull or rebase in a shared checkout; land from a private index"
condition:
  - '(?i)(?<!\becho[\s\S]{0,64})(?<!\bprintf[\s\S]{0,64})\bgit(?<!var\/agent-tmp[\s\S]{0,64})(?![\s\S]{0,64}var\/agent-tmp)(?:\s|\\{1,3}n)+(?:merge|pull|rebase)(?!(?:-base|-tree)\b)(?=[\s;&|)"\x60]|\\n)'
scope: tool:bash
interruptMode: never
---
Don't merge, pull or rebase in a shared checkout: it moves other agents' uncommitted work (a peer's dirty files can refuse your merge, or your merge can swallow theirs). Land from a private index instead: GIT_INDEX_FILE=<scratch>.idx git read-tree origin/main, apply only your hunk --cached, write-tree, commit-tree -p origin/main with the bead id, push the sha to its branch. Ordinary git inside scratch clones under var/agent-tmp is fine.
