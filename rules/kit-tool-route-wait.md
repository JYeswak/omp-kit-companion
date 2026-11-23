---
description: "Route simple sleep polling loops to native job events"
condition:
  - '(?:^\{|,)[ \t]*"command"[ \t]*:[ \t]*"[ \t]*(?:while|until|for)[ \t]+[^;\r\n"''\\]{1,256}(?:;|\\n)[ \t]*do[ \t]+sleep[ \t]+[0-9]+(?:\.[0-9]+)?[ \t]*(?:;|\\n)[ \t]*done[ \t]*"[ \t]*[,}]'
scope: tool:bash
interruptMode: never
---
Use `wait` or job notices instead of polling with `sleep`; completion arrives as an event. Skill: `how-we-work`.
