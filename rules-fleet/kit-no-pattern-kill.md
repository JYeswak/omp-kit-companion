---
condition:
  # Command-word anchor: wire start, the JSON command opener, a shell separator,
  # or sudo. Leading VAR= assignments are consumed at wire start and after the
  # JSON opener (FOO=1 pkill still kills). A bare space is not enough: prose
  # ('never pkill ...') must stay quiet.
  - 'pkill(?<=(?:^\s*(?:[A-Za-z_][A-Za-z0-9_]*=[^\s"\\;&|]*\s+)*|"command"\s*:\s*"\s*(?:[A-Za-z_][A-Za-z0-9_]*=[^\s"\\;&|]*\s+)*|[;&|()]\s*|\bsudo\s+|\\n(?:\\{1,3}t|\s)*|\\t)pkill)(?![\w-])(?=[ \t]+[^\s|"\\])'
  - 'killall(?<=(?:^\s*(?:[A-Za-z_][A-Za-z0-9_]*=[^\s"\\;&|]*\s+)*|"command"\s*:\s*"\s*(?:[A-Za-z_][A-Za-z0-9_]*=[^\s"\\;&|]*\s+)*|[;&|()]\s*|\bsudo\s+|\\n(?:\\{1,3}t|\s)*|\\t)killall)(?![\w-])(?=[ \t]+[^\s|"\\])'
scope: tool:bash
interruptMode: never
---
This kills by pattern, which can hit processes other agents started on this shared machine. `~/.agents/AGENTS.md` (Storing) allows killing only processes you started yourself, by a PID you recorded — never `pkill` or `killall`. Neither dcg nor fleet-guard refuses a pattern kill, so this reminder is the only check. Wait for your own PID to exit, or ask the operator, instead of pattern-matching.
