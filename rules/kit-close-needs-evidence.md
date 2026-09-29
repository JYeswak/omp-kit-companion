---
description: "Kit B2 / forbidden pattern 7: close beads only with cited evidence"
condition:
  - '\b(?:br|bd)\s+close\b(?:(?!\s(?:\\?["''])?(?:--reason|-r|--help|-h)\b)[^;&|"\\])*(?:[";&|]|\\n)'
  - '\b(?:br|bd)\s+close\b[^;&|]*?\s(?:\\?["''])?(?:--reason|-r)(?:\\?["''])?(?:\s+|=)(\\?["''])\1'
  - '\b(?:br|bd)\s+close\b[^;&|]*?\s(?:\\?["''])?(?:--reason|-r)(?:\\?["''])?\s*(?:"\s*[,}]|[;&|]|\\n)'
scope: "tool:bash"
interruptMode: always
---
**Blocked before it ran.** The `bash` call you were in the middle of writing contained `br close` (or `bd close`) with no `--reason`. It was cut off while you wrote it, so it is not in your transcript: the last `bash` call you can see ran normally and is not the blocked one. The blocked call did not execute. Do not re-issue it unchanged.

You are closing a bead without a reason. CHECKLIST.md B2: a bead closes only with a close_reason citing evidence: a commit SHA, the exact command you ran plus its pass output, or a ledger row. "Done", "implemented", or "fixed" is not evidence (forbidden pattern 7, close-pump abuse).

Re-run the bead's acceptance command now, then close with: br close <id> --reason "<command> -> <result>; commit <sha>".
