---
description: "Route recursive symbol searches to the call graph or language server"
condition:
  # Live argument is the shell command, wrapped or raw. A quoted phrase is not a symbol.
  - '(?:^|(?:^\{|,)[ \t]*"command"[ \t]*:[ \t]*")[ \t]*(?:[^"''\\|&;]{0,160}(?:;|&&)[ \t]*)*(?:[A-Za-z_][A-Za-z0-9_]*=[^\s"''\\;&|]*[ \t]+)*grep[ \t]+-[A-Za-z]*[rR][A-Za-z]*[ \t]+(?:[A-Za-z_][A-Za-z0-9_]{0,80}|''[A-Za-z_][A-Za-z0-9_]{0,80}''|"[A-Za-z_][A-Za-z0-9_]{0,80}")(?:[ \t]+[A-Za-z0-9_./+-]+){0,4}'
scope: tool:bash
interruptMode: never
---
Use `ripwire <repo> --callers=<symbol>` / `--uses=<symbol>` or `lsp` references when this command is a recursive `grep` of a symbol. A quoted phrase, a non-recursive `grep`, `rg`, and a quoted example stay quiet. Skill: `ripwire-navigate`.
