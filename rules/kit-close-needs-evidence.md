---
description: "Kit B2 / forbidden pattern 7: close beads only with cited evidence"
condition:
  - 'close(?<=\b(?:br|bd)(?:\s|\\{1,3}[nt])+close\b)(?<!\b(?:echo|printf|am(?:\s|\\{1,3}[nt])+mail(?:\s|\\{1,3}[nt])+(?:send|reply))\b(?:\s+(?:[^\s"''\\;&|()<>\x60]|''[^'']*''|\\"(?:[^"\\]|\\\\(?:\\.|[^\\"])|\\[^"\\])*\\")+)*\s+''[^'']*)(?<!\b(?:echo|printf|am(?:\s|\\{1,3}[nt])+mail(?:\s|\\{1,3}[nt])+(?:send|reply))\b(?:\s+(?:[^\s"''\\;&|()<>\x60]|''[^'']*''|\\"(?:[^"\\]|\\\\(?:\\.|[^\\"])|\\[^"\\])*\\")+)*\s+\\"(?:[^"\\$\x60]|\\\\(?:\\.|[^\\"])|\\[^"\\]|\$(?!\())*)(?:(?!(?:\s|\\{1,3}[nt])+(?:\\?["''])?(?:--reason|-r|--help|-h)\b)(?:[^;&|)"\\]|\\{1,3}[nt]))*(?:[;&|)]|\\n|"(?:[^"\\\n]|\\.)*"(?!(?:(?!\\n)(?:"[^"\n]*"|[^;"\n&|"])*(?:\s|\\{1,3}[nt])+(?:\\?["''])?(?:--reason|-r)\b))|"(?![^"\n]*"))'
  - 'close(?<=\b(?:br|bd)(?:\s|\\{1,3}[nt])+close\b)(?<!\b(?:echo|printf|am(?:\s|\\{1,3}[nt])+mail(?:\s|\\{1,3}[nt])+(?:send|reply))\b(?:\s+(?:[^\s"''\\;&|()<>\x60]|''[^'']*''|\\"(?:[^"\\]|\\\\(?:\\.|[^\\"])|\\[^"\\])*\\")+)*\s+''[^'']*)(?<!\b(?:echo|printf|am(?:\s|\\{1,3}[nt])+mail(?:\s|\\{1,3}[nt])+(?:send|reply))\b(?:\s+(?:[^\s"''\\;&|()<>\x60]|''[^'']*''|\\"(?:[^"\\]|\\\\(?:\\.|[^\\"])|\\[^"\\])*\\")+)*\s+\\"(?:[^"\\$\x60]|\\\\(?:\\.|[^\\"])|\\[^"\\]|\$(?!\())*)[^;&|]*?(?:\s|\\{1,3}[nt])+(?:\\?["''])?(?:--reason|-r)(?:\\?["''])?(?:\s+|=)(\\?["''])\1'
  - 'close(?<=\b(?:br|bd)(?:\s|\\{1,3}[nt])+close\b)(?<!\b(?:echo|printf|am(?:\s|\\{1,3}[nt])+mail(?:\s|\\{1,3}[nt])+(?:send|reply))\b(?:\s+(?:[^\s"''\\;&|()<>\x60]|''[^'']*''|\\"(?:[^"\\]|\\\\(?:\\.|[^\\"])|\\[^"\\])*\\")+)*\s+''[^'']*)(?<!\b(?:echo|printf|am(?:\s|\\{1,3}[nt])+mail(?:\s|\\{1,3}[nt])+(?:send|reply))\b(?:\s+(?:[^\s"''\\;&|()<>\x60]|''[^'']*''|\\"(?:[^"\\]|\\\\(?:\\.|[^\\"])|\\[^"\\])*\\")+)*\s+\\"(?:[^"\\$\x60]|\\\\(?:\\.|[^\\"])|\\[^"\\]|\$(?!\())*)[^;&|]*?(?:\s|\\{1,3}[nt])+(?:\\?["''])?(?:--reason|-r)(?:\\?["''])?\s*(?:"\s*[,}]|[;&|]|\\n)'
scope: "tool:bash"
interruptMode: always
---
**Blocked before it ran.** The `bash` call you were in the middle of writing contained `br close` (or `bd close`) with no `--reason`. It was cut off while you wrote it, so it is not in your transcript: the last `bash` call you can see ran normally and is not the blocked one. The blocked call did not execute. Do not re-issue it unchanged.

You are closing a bead without a reason. CHECKLIST.md B2: a bead closes only with a close_reason citing evidence: a commit SHA, the exact command you ran plus its pass output, or a ledger row. "Done", "implemented", or "fixed" is not evidence (forbidden pattern 7, close-pump abuse).

Re-run the bead's acceptance command now, then close with: br close <id> --reason "<command> -> <result>; commit <sha>".

Quoted `am mail send` and `am mail reply` payloads are data, not close attempts. Command substitutions in double-quoted payloads and actual close commands after a mail command still require evidence.
