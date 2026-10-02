---
condition:
  # Command-word anchor: wire start, the JSON command opener, a shell separator,
  # or sudo. A bare space is not enough: prose ('never pkill ...') must stay quiet.
  - '(?:^|\{"command":"|[;&|()]\s*|\bsudo\s+)(pkill|killall)(?![\w-])'
interruptMode: never
---
This kills by pattern, which can hit processes other agents started on this shared machine. AGENTS.md (Storing) allows killing only processes you started yourself, by a PID you recorded — never `pkill` or `killall`. Wait for your own PID to exit, or ask the operator, instead of pattern-matching.
