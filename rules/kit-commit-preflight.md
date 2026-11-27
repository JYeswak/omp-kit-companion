---
description: "C05: route a real Git commit that has not already named preflight"
condition:
  # A complete commit-preflight.sh token within 80 characters before this git,
  # or 120 after it, stays quiet; similarly for help or dry-run. Wait for the next complete word or
  # command delimiter so a streamed "git commit " cannot fire before "--help".
  # A shell continuation can be raw or escaped inside a streamed JSON string.
  - 'git(?<!(?:^|[/\s"''])commit-preflight\.sh(?=$|[\s;&|)"''\x60]|\\[nrt])[\s\S]{0,80})(?![\s\S]{0,120}(?:[/\s"''])commit-preflight\.sh(?=$|[\s;&|)"''\x60]|\\[nrt]))(?<=\bgit|\\ngit|\\tgit)(?=\s+(?:-C\s+[^\s"\\;&|]+\s+)?commit(?=[\s;&|)"\x60]|\\n)(?=\s*(?:[;&|)"\x60]|\\n|[^\s;&|)"\x60]+[\s;&|)"\x60]))(?!\s+(?:(?:[\\]\r?\n|[\\]{3}(?:r[\\])?n)[ \t]*)*(?:--dry-run|--help|-h)\b))(?<!\b(?:echo|printf|e?grep|fgrep|rg|ag|ack)\b(?:\s+(?:[^\s"''\\;&|()<>\x60]|''[^'']*''|\\"(?:[^"\\]|\\\\(?:\\.|[^\\"])|\\[^"\\])*\\")+)*\s+''[^'']*)(?<!\b(?:echo|printf|e?grep|fgrep|rg|ag|ack)\b(?:\s+(?:[^\s"''\\;&|()<>\x60]|''[^'']*''|\\"(?:[^"\\]|\\\\(?:\\.|[^\\"])|\\[^"\\])*\\")+)*\s+\\"(?:[^"\\$\x60]|\\\\(?:\\.|[^\\"])|\\[^"\\]|\$(?!\())*)(?<=(?:^|"command"\s*:\s*"|[;&|(]|\\n|\\t)\s*(?:[A-Za-z_][A-Za-z0-9_]*=[^\s"\\;&|]*\s+)*(?:(?:env|sudo|time)\s+)*(?:command\s+)?git)'
scope: "tool:bash"
interruptMode: never
---
**kit-commit-preflight — before a real `git commit` in a kit-enabled repository, run `sh scripts/commit-preflight.sh --message MESSAGE_FILE` against the exact staged tree and final message.** Use `--files PATH...` for a planned `git commit --only`; commit with that same message file. Fix every REFUSED or UNJUDGED result before starting the expensive commit gate. Without `--message`, message-dependent checks are NOT_JUDGED, not admission.

This reminder stays quiet when a complete `commit-preflight.sh` script name is within 80 characters before `git` or 120 after it, and on `git commit --dry-run`, `--help`, or `-h`. An incidental filename with `commit-preflight` in its name does not count. TTSR sees this call's text, not a previous preflight's exit. Do not repeat a completed exact preflight merely because a reminder appeared. Native hooks remain authoritative. Preserve foreign landed hunks; never paste a Supersedes trailer as a password to make a refusal disappear.
