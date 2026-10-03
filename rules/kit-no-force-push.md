---
condition:
  # A streaming prefix ending right after --force must not fire: the flag needs a
  # real delimiter (shell separator, JSON wire close, or escaped newline), and the
  # lease form is excluded. Short -f only counts after push.
  - '--force(?:(?<=\\t--force)|(?<![\w''"\x60-]--force))(?!-with-lease)(?=[\s;&|)"\x60]|\\n)(?<!\b(?:echo|printf)\b(?:\s+(?:[^\s"''\\;&|()<>\x60]|''[^'']*''|\\"(?:[^"\\]|\\\\(?:\\.|[^\\"])|\\[^"\\])*\\")+)*\s+''[^'']*)(?<!\b(?:echo|printf)\b(?:\s+(?:[^\s"''\\;&|()<>\x60]|''[^'']*''|\\"(?:[^"\\]|\\\\(?:\\.|[^\\"])|\\[^"\\])*\\")+)*\s+\\"(?:[^"\\$\x60]|\\\\(?:\\.|[^\\"])|\\[^"\\]|\$(?!\())*)'
  - 'push(?<!\wpush)(?=\s+(?:\S+\s+)*?-f(?=[\s;&|)"\x60]|\\n))(?<!\b(?:echo|printf)\b(?:\s+(?:[^\s"''\\;&|()<>\x60]|''[^'']*''|\\"(?:[^"\\]|\\\\(?:\\.|[^\\"])|\\[^"\\])*\\")+)*\s+''[^'']*)(?<!\b(?:echo|printf)\b(?:\s+(?:[^\s"''\\;&|()<>\x60]|''[^'']*''|\\"(?:[^"\\]|\\\\(?:\\.|[^\\"])|\\[^"\\])*\\")+)*\s+\\"(?:[^"\\$\x60]|\\\\(?:\\.|[^\\"])|\\[^"\\]|\$(?!\())*)'
  - '\\{3}n--force(?<!\b(?:echo|printf)\b(?:\s+(?:[^\s"''\\;&|()<>\x60]|''[^'']*''|\\"(?:[^"\\]|\\\\(?:\\.|[^\\"])|\\[^"\\])*\\")+)*\s+''[^'']*)(?<!\b(?:echo|printf)\b(?:\s+(?:[^\s"''\\;&|()<>\x60]|''[^'']*''|\\"(?:[^"\\]|\\\\(?:\\.|[^\\"])|\\[^"\\])*\\")+)*\s+\\"(?:[^"\\$\x60]|\\\\(?:\\.|[^\\"])|\\[^"\\]|\$(?!\())*)(?!-with-lease)(?=[\s;&|)"\x60]|\\n)'
scope: tool:bash
interruptMode: never
---
This force-pushes without `--force-with-lease`. AGENTS.md (Pushing) forbids plain force-pushes; `--force-with-lease` needs explicit human approval, and PR repos never take direct default-branch pushes. Re-push normally, or stop and ask for the lease form.
