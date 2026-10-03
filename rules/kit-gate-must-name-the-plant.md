---
condition: '(?=(?:^|"command"\s*:\s*"|[;&|(]|\\n))(?<!\b(?:echo|printf)\b(?:\s+(?:[^\s"''\\;&|()<>\x60]|''[^'']*''|\\"(?:[^"\\]|\\\\(?:\\.|[^\\"])|\\[^"\\])*\\")+)*\s+''[^'']*)(?<!\b(?:echo|printf)\b(?:\s+(?:[^\s"''\\;&|()<>\x60]|''[^'']*''|\\"(?:[^"\\]|\\\\(?:\\.|[^\\"])|\\[^"\\])*\\")+)*\s+\\"(?:[^"\\$\x60]|\\\\(?:\\.|[^\\"])|\\[^"\\]|\$(?!\())*)(?:^|"command"\s*:\s*"|[;&|(]|\\n)\s*(?:[A-Za-z_][A-Za-z0-9_]*=[^\s"\\;&|]*\s+)*(?:(?:env|sudo|time)\s+)*(?:(?:ba|z|da)?sh\s+(?:-[A-Za-z]+\s+)*|source\s+|\.\s+)?[^\s"''\\;&|]*starter-kit/scripts/(?:check-claim-discipline|init)\.sh\b'
scope: tool:bash
interruptMode: never
---
You are running the starter-kit copy of a checker. Do not adopt a gate that cannot detect a planted bad row. On macOS `/bin/sh`, the bundled starter-kit checker used an IFS separator that failed to split an `enforce=yes` row; a missing claims file also returned success in that copy.

The fixed checker is in the omp-kit checkout. From its root, run `sh checkers/check-claim-discipline.sh --selftest` first: it refuses a planted unmatched row and names it, passes a matching row, and refuses a missing file. A gate whose RED does not name the plant is not a gate.

Do not run `starter-kit/scripts/init.sh` in a repo that already has `AGENTS.md` or a live git hook. It installs a second pre-commit hook. `copy_new` keeps existing files; the hook install does not ask.
