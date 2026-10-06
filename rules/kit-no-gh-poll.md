---
description: "Stop direct or looped GitHub Actions status polling"
condition:
  - '(?i)(?:\{"command":"(?:\s|\\[nrt]|\\\\\\[nrt])*|[;&|()](?:\s|\\[nrt]|\\\\\\[nrt])*|\\n(?:\\{1,3}t|\s)*|\b(?:if|then|do|while|until)(?:\s|\\[nrt]|\\\\\\[nrt])+)(?:[A-Za-z_][A-Za-z0-9_]*=[^\s"\\;&|]*(?:\s|\\[nrt]|\\\\\\[nrt])+)*gh(?:\s|\\[nrt]|\\\\\\[nrt])+run(?:\s|\\[nrt]|\\\\\\[nrt])+watch\b'
  - '(?i)(?:\{"command":"(?:\s|\\[nrt]|\\\\\\[nrt])*|[;&|()](?:\s|\\[nrt]|\\\\\\[nrt])*|\\n(?:\\{1,3}t|\s)*|\b(?:if|then|do)(?:\s|\\[nrt]|\\\\\\[nrt])+)(?:[A-Za-z_][A-Za-z0-9_]*=[^\s"\\;&|]*(?:\s|\\[nrt]|\\\\\\[nrt])+)*(?:for|while|until)\b(?=(?:\s|\\[nrt]|\\\\\\[nrt])*(?:[A-Za-z_][A-Za-z0-9_]*=[^\s"\\;&|]*(?:\s|\\[nrt]|\\\\\\[nrt])+)*gh(?:\s|\\[nrt]|\\\\\\[nrt])+(?:run(?:\s|\\[nrt]|\\\\\\[nrt])+(?:view|list)|api)\b|(?:(?!\bdone\b)[\s\S]){0,2048}(?:[;&|()](?:\s|\\[nrt]|\\\\\\[nrt])*|\b(?:if|then|do|while|until)(?:\s|\\[nrt]|\\\\\\[nrt])+|\\n(?:\\{1,3}t|\s)*)(?:[A-Za-z_][A-Za-z0-9_]*=[^\s"\\;&|]*(?:\s|\\[nrt]|\\\\\\[nrt])+)*gh(?:\s|\\[nrt]|\\\\\\[nrt])+(?:run(?:\s|\\[nrt]|\\\\\\[nrt])+(?:view|list)|api)\b)(?=(?:\s|\\[nrt]|\\\\\\[nrt])*(?:[A-Za-z_][A-Za-z0-9_]*=[^\s"\\;&|]*(?:\s|\\[nrt]|\\\\\\[nrt])+)*sleep\b|(?:(?!\bdone\b)[\s\S]){0,2048}(?:[;&|()](?:\s|\\[nrt]|\\\\\\[nrt])*|\b(?:if|then|do|while|until)(?:\s|\\[nrt]|\\\\\\[nrt])+|\\n(?:\\{1,3}t|\s)*)(?:[A-Za-z_][A-Za-z0-9_]*=[^\s"\\;&|]*(?:\s|\\[nrt]|\\\\\\[nrt])+)*sleep\b)(?:(?!\bdone\b)[\s\S]){0,2048}\bdone\b'
scope: "tool:bash"
interruptMode: always
---
This repeatedly polls GitHub Actions and consumes shared API quota. Use `omp-kit ci status` to read the local CI cache instead. If that status command fails, stop and report the GH2 bug; do not fall back to `gh run watch` or a polling loop.
