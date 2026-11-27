---
description: "C05: route a real Git commit that has not already named preflight"
condition:
  # Stay quiet when commit-preflight is within 80 characters before this git,
  # or 120 after it, and on help or dry-run. Wait for the next complete word or
  # command delimiter so a streamed "git commit " cannot fire before "--help".
  - 'git(?<!commit-preflight[\s\S]{0,80})(?![\s\S]{0,120}commit-preflight)(?<=\bgit|\\ngit|\\tgit)(?=\s+(?:-C\s+[^\s"\\;&|]+\s+)?commit(?=[\s;&|)"\x60]|\\n)(?=\s*(?:[;&|)"\x60]|\\n|[^\s;&|)"\x60]+[\s;&|)"\x60]))(?!\s+(?:--dry-run|--help|-h)\b))(?<!\b(?:echo|printf|e?grep|fgrep|rg|ag|ack)\b(?:\s+(?:[^\s"''\\;&|()<>\x60]|''[^'']*''|\\"(?:[^"\\]|\\\\(?:\\.|[^\\"])|\\[^"\\])*\\")+)*\s+''[^'']*)(?<!\b(?:echo|printf|e?grep|fgrep|rg|ag|ack)\b(?:\s+(?:[^\s"''\\;&|()<>\x60]|''[^'']*''|\\"(?:[^"\\]|\\\\(?:\\.|[^\\"])|\\[^"\\])*\\")+)*\s+\\"(?:[^"\\$\x60]|\\\\(?:\\.|[^\\"])|\\[^"\\]|\$(?!\())*)(?<=(?:^|"command"\s*:\s*"|[;&|(]|\\n|\\t)\s*(?:[A-Za-z_][A-Za-z0-9_]*=[^\s"\\;&|]*\s+)*(?:(?:env|sudo|time)\s+)*(?:command\s+)?git)'
scope: "tool:bash"
interruptMode: never
---
**kit-commit-preflight — before a real `git commit` in a kit-enabled repository, run `sh scripts/commit-preflight.sh --message MESSAGE_FILE` against the exact staged tree and final message.** Use `--files PATH...` for a planned `git commit --only`; commit with that same message file. Fix every REFUSED or UNJUDGED result before starting the expensive commit gate. Without `--message`, message-dependent checks are NOT_JUDGED, not admission.

This reminder stays quiet when `commit-preflight` is in the same command within 80 characters before `git` or 120 after it, and on `git commit --dry-run`, `--help`, or `-h`. It does not attach to every commit verb. TTSR sees this call's text, not a previous preflight's exit. Do not repeat a completed exact preflight merely because a reminder appeared. Native hooks remain authoritative. Preserve foreign landed hunks; never paste a Supersedes trailer as a password to make a refusal disappear.
