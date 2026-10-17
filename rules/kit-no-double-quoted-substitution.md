---
description: "Never pass a double-quoted argument containing command substitution to br or git commit"
condition:
  - '\b(?:(?:br|bd)(?:[ \t]+--\S+(?:[ \t]+[^\s"'';&|]+)?)*[ \t]+(?:comments[ \t]+add|create|update)|git[ \t]+commit\b[^\s;&|]*(?:[ \t]+--\S+)*[ \t]+-m)\b[^;&]*(?:"(?:[^"\\]|\\.)*(?<!\\)(?:\\\\\\\\)*(?:\x60|\$\()[^"]*")'
scope: tool:bash
interruptMode: tool-only
---
A double-quoted shell argument containing a backtick or `$(` runs command substitution before the command sees it. On `br comments add`, `br create`, `br update` or `git commit -m` that publishes the substituted output — in 2026-10-10 it published the agent's full process environment, bearer and client secret included, into a durable tracker comment; on 2026-10-16 a Markdown backtick in a comment ran a sync script with `--apply` and changed 9 shared records. The call is stopped before it runs: single-quote the argument (single quotes run nothing), pass the text with `-f <file>`, or drop the substitution; an escaped backtick stays quiet, and so do `$VAR` and `${VAR}` without a paren.
