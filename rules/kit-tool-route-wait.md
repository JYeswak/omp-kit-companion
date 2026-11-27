---
description: "Route simple sleep polling loops to native job events"
condition:
  # Live argument is the shell command, wrapped or raw. sleep must be the loop body, not a quoted word.
  - '(?:^|(?:^\{|,)[ \t]*"command"[ \t]*:[ \t]*")[ \t]*(?:[^"''\\|&;]{0,80}(?:;|&&)[ \t]*)*(?:while|until|for)[ \t]+[^;\r\n]{1,200}(?:;|\\n)[ \t]*do[ \t]+sleep[ \t]+[0-9]+(?:\.[0-9]+)?\b[\s\S]{0,40}?\bdone\b'
scope: tool:bash
interruptMode: never
---
Use `wait` or job notices when this command is a `while`, `until`, or `for` loop whose body is `sleep`. A single `sleep`, a loop that only prints `sleep`, and a quoted example stay quiet. Skill: `how-we-work`.
