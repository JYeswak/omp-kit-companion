---
description: "C05: route real Git commits to cheap staged-tree and final-message preflight"
condition:
  # Reuse the starter-kit checker router's prefix and inert-print exclusions.
  # Reject non-command tokens and non-commit suffixes before unbounded context,
  # as kit-no-verify does; repeated "git" near-misses must not scan their history.
  - 'git(?<=\bgit|\\ngit|\\tgit)(?=\s+(?:-C\s+[^\s"\\;&|]+\s+)?commit(?=[\s;&|)"\x60]|\\n))(?<!\b(?:echo|printf)\b(?:\s+(?:[^\s"''\\;&|()<>\x60]|''[^'']*''|\\"(?:[^"\\]|\\\\(?:\\.|[^\\"])|\\[^"\\])*\\")+)*\s+''[^'']*)(?<!\b(?:echo|printf)\b(?:\s+(?:[^\s"''\\;&|()<>\x60]|''[^'']*''|\\"(?:[^"\\]|\\\\(?:\\.|[^\\"])|\\[^"\\])*\\")+)*\s+\\"(?:[^"\\$\x60]|\\\\(?:\\.|[^\\"])|\\[^"\\]|\$(?!\())*)(?<=(?:^|"command"\s*:\s*"|[;&|(]|\\n|\\t)\s*(?:[A-Za-z_][A-Za-z0-9_]*=[^\s"\\;&|]*\s+)*(?:(?:env|sudo|time)\s+)*(?:command\s+)?git)'
scope: "tool:bash"
interruptMode: never
---
**kit-commit-preflight — before committing in a kit-enabled repository, run `sh scripts/commit-preflight.sh --message MESSAGE_FILE` against the exact staged tree and final message.** Use `--files PATH...` for a planned `git commit --only`; commit with that same message file. Fix every REFUSED or UNJUDGED result before starting the expensive commit gate. Without `--message`, message-dependent checks are NOT_JUDGED, not admission.

This is a routing reminder, not proof or a cache: TTSR sees this call's text, not the repository's kit status or a previous preflight's exit/tree/message identity. Do not repeat a completed exact preflight merely because this reminder appears. Native hooks remain authoritative. Preserve foreign landed hunks; never paste a Supersedes trailer as a password to make a refusal disappear.
