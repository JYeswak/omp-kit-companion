---
condition: 'grep[^|;&]*\*[^|;&]*2>/dev/null'
scope: tool:bash
interruptMode: never
---
This `grep` reads a glob path with stderr silenced. If the glob matches no path, grep prints nothing and exits 1 — so **"no such path" is indistinguishable from "no matches."** Measured in this fleet's own command history: 820 of 78,242 commands (1.05%). Before trusting an empty result, echo the expanded path or drop `2>/dev/null` once.
