---
description: "Forbid raw live-tracker SQLite readers: use native br/bv or disposable copies; beads_rust#532 stays a mitigation"
condition:
  - '\bsqlite3\s+["'']?[^"'']*\.beads[\\/]beads\.db'
  - '"(path|file|uri|database)"\s*:\s*"[^"]*\.beads[\\/]beads\.db"'
  # A string prefix (f, r, b, u, rb, ...) and up to three backslashes may precede the quote:
  # bash and eval arguments arrive JSON-escaped, so f"x" streams as f\"x\" and a quote escaped
  # inside a bash double-quoted argument streams as \\\". The literal .beads/beads.db must
  # still sit inside that string.
  - '(sqlite3?|Database)(\s*\(\s*|\s*\.\s*(open|connect)\s*\(\s*)(?:[rRbBfFuU]{1,2})?(?:\\{1,3})?["''][^"'']*\.beads[\\/]beads\.db'
  - 'ATTACH\s+(DATABASE\s+)?["''][^"'']*\.beads[\\/]beads\.db'
scope: tool:bash, tool:eval, tool:write, tool:edit
interruptMode: always
---
**Blocked before it ran.** The command you were composing opens the live tracker database directly instead of going through the native tracker tools. It was cut off while you wrote it, so the blocked call did not execute. Do not re-issue it unchanged.

A raw SQLite reader on a live `.beads/beads.db` races the tracker writer: reads can observe a half-written page, and any writer handle (including a lingering open from a persistent eval kernel) can wedge the next migration or recovery. Eval cells are covered too: the measured outages (2026-10-13, 10-22, 10-24) each came from a persistent eval kernel holding such a connection. Use the native tools instead:

- `br list`, `br show <id>`, `bv --robot-triage` and the other native read commands stay quiet under this rule.
- To run SQL, copy the database to a disposable path first (`var/agent-tmp/<label>.<pid>/beads-copy.db`), then open the copy. The copy must not live at a `.beads/beads.db` path or this rule still fires.

`beads_rust#532` remains UNCONFIRMED; the quarantine bound, the holder latches, and this rule are mitigations only, not a fix for the upstream cause.
