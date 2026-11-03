---
description: "br has no --readonly flag: use supported read commands without inventing flags"
condition:
  - '(?:^|[;&|\n]|"command"\s*:\s*")\s*br[ \t]+--readonly\b'
  - '(?:\[|,)\s*\\?["\x27]br\\?["\x27]\s*,\s*\\?["\x27]--readonly\\?["\x27]'
scope: tool:bash,tool:eval
interruptMode: never
---
**Do not execute this call: `br --readonly` is unsupported.** Remove `--readonly` before running it. Use native read commands such as `br show <id> --json`, `br list`, or `br comments list`; consult `br --help` for supported options. `--no-auto-import` is a separate supported option, not a read-only guarantee. Never substitute a mutation or bypass database freshness checks to make a read succeed.

DAILYCLASSES row 33: a Python argv call put `--readonly` immediately after `br`, received exit 2, and then failed an assertion. That was an unsupported-flag failure, not an eval timeout. This reminder covers that command/argv shape; it does not certify arbitrary shell or source parsing.
