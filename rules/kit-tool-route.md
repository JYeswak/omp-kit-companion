---
description: "Route standalone single-file shell reads to the native read tool"
condition:
  - '(?:^\{|,)[ \t]*"command"[ \t]*:[ \t]*"[ \t]*(?:[^"''\\|&;]{1,200}(?:;|&&)[ \t]*)*(?:[A-Za-z_][A-Za-z0-9_]*=[^\s"''\\;&|]*[ \t]+)*(?:cat(?:[ \t]+--)?|(?:head|tail)(?:[ \t]+(?:-n[ \t]+[0-9]+|-[0-9]+))?|sed[ \t]+-n[ \t]+(?:''[0-9]+(?:,[0-9]+)?p''|[0-9]+(?:,[0-9]+)?p))[ \t]+(?:[A-Za-z0-9_./][A-Za-z0-9_./+-]*|''[A-Za-z0-9_./][A-Za-z0-9_./+ -]*'')[ \t]*"[ \t]*[,}]'
scope: tool:bash
interruptMode: never
---
Use `read` with a line selector for one file; it provides stable anchors and avoids a shell cut. Skill: `how-we-work`.
