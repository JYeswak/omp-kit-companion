---
description: "AGENTS.md Storing: never ask the human to clear scratch with rm -rf"
condition:
  - '(?i)(?<!not )(?<!never )(?<!n''t )\b(?:please\s+)?(?:run|execute)\s+rm\s+-rf\b'
scope: text
interruptMode: prose-only
---
This asks the human to clear scratch with `rm -rf`. AGENTS.md (Storing) forbids it in both directions: never `rm -rf` scratch yourself, and never ask the human to. The machine reaper deletes owned scratch dirs once their owner process is dead; unowned dirs age out through quarantine on their own.
