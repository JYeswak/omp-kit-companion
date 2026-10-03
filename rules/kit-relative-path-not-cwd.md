---
condition: '(?=(?:^|"command"\s*:\s*"|[;&|(]|\\n))(?<!\b(?:echo|printf)\b(?:\s+(?:[^\s"''\\;&|()<>\x60]|''[^'']*''|\\"(?:[^"\\]|\\\\(?:\\.|[^\\"])|\\[^"\\])*\\")+)*\s+''[^'']*)(?<!\b(?:echo|printf)\b(?:\s+(?:[^\s"''\\;&|()<>\x60]|''[^'']*''|\\"(?:[^"\\]|\\\\(?:\\.|[^\\"])|\\[^"\\])*\\")+)*\s+\\"(?:[^"\\$\x60]|\\\\(?:\\.|[^\\"])|\\[^"\\]|\$(?!\())*)(?:^|"command"\s*:\s*"|[;&|(]|\\n)\s*(?:[A-Za-z_][A-Za-z0-9_]*=[^\s"\\;&|]*\s+)*(?:(?:env|sudo|time)\s+)*(?:(?:ba|z|da)?sh\s+(?:-[A-Za-z]+\s+)*|source\s+|\.\s+)?[^\s"''\\;&|]*starter-kit/scripts/check-readiness\.sh\b'
scope: tool:bash
interruptMode: never
---
You are running the starter-kit copy of `check-readiness.sh`. It resolves a relative packet against the caller cwd. `sh /path/to/check-readiness.sh notes/packet.md` from `/tmp` reports the file missing. That is a cwd bug, not an empty packet.

The fixed checker is in the omp-kit checkout: from its root run `sh checkers/check-readiness.sh --selftest`. It resolves a relative packet path against the root argument. The starter-kit checker also accepted a design-only sign-off because `sign` was matched as a substring; the fixed checker requires the whole word `signed` or `sign-off`.
