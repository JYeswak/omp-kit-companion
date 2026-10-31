---
condition: '2>/dev/null\s*\|\s*(?:grep|jq|head|tail|wc|awk|cut)\b(?<!\b(?:echo|printf)\b(?:\s+(?:[^\s"''\\;&|()<>\x60]|''[^'']*''|\\"(?:[^"\\]|\\\\(?:\\.|[^\\"])|\\[^"\\])*\\")+)*\s+''[^'']*)(?<!\b(?:echo|printf)\b(?:\s+(?:[^\s"''\\;&|()<>\x60]|''[^'']*''|\\"(?:[^"\\]|\\\\(?:\\.|[^\\"])|\\[^"\\])*\\")+)*\s+\\"(?:[^"\\$\x60]|\\\\(?:\\.|[^\\"])|\\[^"\\]|\$(?!\())*)'
scope: tool:bash
interruptMode: never
---
Stderr is discarded before the producer is piped into a filter. Capture the complete output and exit code first; then filter. Otherwise an empty result can hide a command failure.
