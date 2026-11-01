---
# Keep the bounded echo/printf exclusion before the pipe, which can itself be quoted text.
condition: '2>/dev/null(?<!(?:^|"command"\s{0,8}:\s{0,8}"|[;&|\n\x60]|\$\(|(?<!\\)(?:\\\\){0,32}\\n)\s{0,64}(?:echo|printf)\b(?:[^;&|\n\x60$\\]|\$(?!\()|\\[^n]){0,256})\s*\|\s*(?:grep|jq|head|tail|wc|awk|cut)\b'
scope: tool:bash
interruptMode: never
---
Stderr is discarded before the producer is piped into a filter. Capture the complete output and exit code first; then filter. Otherwise an empty result can hide a command failure.
