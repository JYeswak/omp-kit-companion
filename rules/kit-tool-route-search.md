---
description: "Route recursive symbol searches to the call graph or language server"
condition:
  - '(?:^\{|,)[ \t]*"command"[ \t]*:[ \t]*"[ \t]*grep[ \t]+-(?:[rR]n|n[rR])[ \t]+(?:[A-Za-z_][A-Za-z0-9_]*|''[A-Za-z_][A-Za-z0-9_]*'')[ \t]+(?:\.|\./|(?:\./)?(?:src|lib|app|packages|crates)(?:/[A-Za-z0-9_-]+)*/?)[ \t]*"[ \t]*[,}]'
scope: tool:bash
interruptMode: never
---
Use `ripwire <repo> --callers=<symbol>` / `--uses=<symbol>` or `lsp` references to find actual symbol uses, not text matches. Skill: `ripwire-navigate`.
