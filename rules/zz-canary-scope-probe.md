---
condition: 'zzzz_systemwide_canary_9c42(?<!\b(?:echo|printf)\b(?:\s+(?:[^\s"''\\;&|()<>\x60]|''[^'']*''|\\"(?:[^"\\]|\\\\(?:\\.|[^\\"])|\\[^"\\])*\\")+)*\s+''[^'']*)(?<!\b(?:echo|printf)\b(?:\s+(?:[^\s"''\\;&|()<>\x60]|''[^'']*''|\\"(?:[^"\\]|\\\\(?:\\.|[^\\"])|\\[^"\\])*\\")+)*\s+\\"(?:[^"\\$\x60]|\\\\(?:\\.|[^\\"])|\\[^"\\]|\$(?!\())*)'
scope: tool:bash
interruptMode: never
---
CANARY — system-wide TTSR discovery probe, 2026-09-20. If you are reading this in a
session, then `~/.agents/rules/` loads for this profile and this project, which is the
question it exists to answer. High-entropy condition so it can never fire on real work.
Remove only after the kit maintainer approves retiring this coverage check.
