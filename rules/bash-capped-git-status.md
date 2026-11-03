---
# CAPPEDREAD1: intercept the lossy observation, not a guessed later decision.
condition:
  - '(?:^|"command"\s*:\s*"|[;&|\n]|\\n)\s*git\s+(?:-C\s+[^;|\n]{1,256}?\s+)?status\b[^;|\n]{0,512}\|\s*(?:head|tail|cut)\b'
  # Eval's serialized code retains the helper/command and the printed slice.
  - '(?:\bg\s*\(|subprocess\.(?:run|check_output|Popen)\s*\([\s\S]{0,256}?\bgit\b)[\s\S]{0,256}?\bstatus\b[\s\S]{0,4096}?(?:\b|\\[nt])print\s*\(\s*[A-Za-z_]\w*(?:\.stdout)?(?:\.splitlines\(\))?\s*\[\s*:\s*(?:[0-9]{1,9}|[A-Za-z_]\w*)\s*\]'
scope: tool:bash, tool:eval
interruptMode: always
---
Do not cap the working-tree inventory. A Python eval captured git status and printed `out[:800]`, hiding 36 untracked replacement files before a destructive restore decision (CAPPEDREAD1). Capture the complete status and its exit code; inspect every tracked and untracked path before deciding whether restore, checkout, clean or removal can discard unique bytes. Print the whole result or write it to a file and read it completely. If tool output is truncated, read the complete retained artifact before deciding. A preview is not proof of absence. This tripwire covers direct bash status-to-cap pipelines and same-cell Python `g('status', ...)` / subprocess captures followed by printed variable slices, within bounded token windows. It cannot establish what an agent inferred from an earlier tool result, or follow aliases/data flow across cells.
