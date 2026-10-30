---
condition: '2>/dev/null\s*\|\s*(?:grep|jq|head|tail|wc|awk|cut)\b'
scope: tool:bash
interruptMode: never
---
Stderr is discarded before the producer is piped into a filter. Capture the complete output and exit code first; then filter. Otherwise an empty result can hide a command failure.
