---
description: "DAILYCLASSES row 38: scope repository searches before including ignored files"
condition:
  - '^\{(?=[^\r\n]*"path"\s*:\s*"\."\s*[,}])(?=[^\r\n]*"gitignore"\s*:\s*false\s*[,}])'
scope: tool:grep
interruptMode: never
---
kit-grep-root-ignored: this grep searches the entire checkout including ignored files. A retained call with path `.` and gitignore false timed out after 30 seconds. First locate the relevant directories or files, then search those explicit paths; keep gitignore enabled unless ignored material is actually required. A deliberately bounded small checkout can legitimately need this call, so this is advisory, not a refusal or a guarantee that the narrower search finishes.
