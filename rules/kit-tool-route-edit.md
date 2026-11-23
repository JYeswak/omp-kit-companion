---
description: "Route common shell-based source rewrites to anchored or structural edits"
condition:
  - '(?:^\{|,)[ \t]*"command"[ \t]*:[ \t]*"[ \t]*(?:[^"''\\|&;]{1,200}(?:;|&&)[ \t]*)*(?:[A-Za-z_][A-Za-z0-9_]*=[^\s"''\\;&|]*[ \t]+)*sed[ \t]+(?:-i(?:[.]bak)?|--in-place(?:=[.]bak)?)[ \t]+(?:''''[ \t]+)?(?:-e[ \t]+)?''[^''\r\n]{1,512}''[ \t]+[A-Za-z0-9_./+-]+\.(?:[cm]?[jt]sx?|py|rs|go|java|c|h|cpp|sh)[ \t]*"[ \t]*[,}]'
  - '(?:^\{|,)[ \t]*"command"[ \t]*:[ \t]*"[ \t]*(?:[^"''\\|&;]{1,200}(?:;|&&)[ \t]*)*(?:[A-Za-z_][A-Za-z0-9_]*=[^\s"''\\;&|]*[ \t]+)*python(?:3(?:\.[0-9]+)?)?[ \t]+-c[ \t]+''(?=[^''\r\n]{0,256}\.(?:[cm]?[jt]sx?|py|rs|go|java|c|h|cpp|sh)\\")[^''\r\n]{0,512}\.write_text\([^''\r\n]{0,256}\.replace\([^''\r\n]{0,256}''[ \t]*"[ \t]*[,}]'
scope: tool:bash
interruptMode: never
---
Use `edit` for anchored changes or `ast_edit` for structural ones; string rewrites can touch unrelated code. Skill: `ast-parsing-engineering`.
