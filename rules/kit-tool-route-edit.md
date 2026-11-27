---
description: "Route in-place source rewrites to anchored or structural edits"
condition:
  # Live argument is the shell command, wrapped or raw. Quiet on stream sed and non-source paths.
  - '(?:^|(?:^\{|,)[ \t]*"command"[ \t]*:[ \t]*")[ \t]*(?:[^"''\\|&;]{0,160}(?:;|&&)[ \t]*)*(?:[A-Za-z_][A-Za-z0-9_]*=[^\s"''\\;&|]*[ \t]+)*sed[ \t]+(?:-i(?:\.[A-Za-z0-9]+)?|--in-place)[ \t]+(?:''''[ \t]+)?(?:-e[ \t]+)?(?:''[^''\r\n]{1,200}''|"[^"\r\n]{1,200}")[ \t]+[A-Za-z0-9_./+-]+\.(?:[cm]?[jt]sx?|py|rs|go|java|c|h|cpp|sh)\b'
  - '(?:^|(?:^\{|,)[ \t]*"command"[ \t]*:[ \t]*")[ \t]*(?:[^"''\\|&;]{0,80}(?:;|&&)[ \t]*)*python(?:3(?:\.[0-9]+)?)?[ \t]+-c[ \t]+[\s\S]{0,400}\.(?:[cm]?[jt]sx?|py|rs|go|java|c|h|cpp|sh)[\s\S]{0,200}write_text\([\s\S]{0,200}replace\('
  - '(?:^|(?:^\{|,)[ \t]*"command"[ \t]*:[ \t]*")[ \t]*(?:[^"''\\|&;]{0,80}(?:;|&&)[ \t]*)*perl[ \t]+-[A-Za-z]*i[\s\S]{0,200}\.(?:[cm]?[jt]sx?|py|rs|go|java|c|h|cpp|sh)\b'
scope: tool:bash
interruptMode: never
---
Use `edit` for anchored changes or `ast_edit` for structural ones when this command runs `sed -i`, `perl -i`, or `python -c` `write_text`/`replace` on a source file. A stream `sed`, a non-source path, and a quoted example stay quiet. Skill: `ast-parsing-engineering`.
