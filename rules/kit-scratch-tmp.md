---
condition:
  - '"path"[ \t]*:[ \t]*"/tmp/'
  - '"file"[ \t]*:[ \t]*"/tmp/'
  - '>(>)?[ \t]*/tmp/'
scope: tool:bash, tool:write, tool:edit
interruptMode: never
---
This writes scratch to `/tmp`, which the machine reaper never cleans. AGENTS.md (Storing) requires scratch under the repo's `var/agent-tmp/<label>.<pid>/` with an `.owner` file — never `/tmp` or `~`. Redirect under `var/agent-tmp/` (or `$TMPDIR` when it points there) instead; reads from `/tmp` are not writes and stay quiet.
