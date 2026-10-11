---
description: "Never pass a double-quoted argument containing command substitution to br or git commit"
condition:
  - '\b(?:(?:br|bd)(?:[ \t]+--\S+(?:[ \t]+[^\s"'';&|]+)?)*[ \t]+(?:comments[ \t]+add|create|update)|git[ \t]+commit\b[^\s;&|]*(?:[ \t]+--\S+)*[ \t]+-m)\b[^;&]*(?:"(?:[^"\\]|\\.)*(?<!\\)(?:\\\\\\\\)*(?:\x60|\$\()[^"]*")'
scope: tool:bash
interruptMode: never
---
A double-quoted shell argument containing a backtick or `$(` runs command substitution before the command sees it. On `br comments add`, `br create`, `br update` or `git commit -m` that publishes the substituted output — in 2026-10-10 it published the agent's full process environment, bearer and client secret included, into a durable tracker comment. Single-quote the argument (single quotes run nothing) or drop the substitution; an escaped backtick stays quiet, and so do `$VAR` and `${VAR}` without a paren. This is a reminder, not a block: fix the quoting in the same turn.
