---
description: "Tool-result text is not JSON: parse inside the command with jq, never JSON.parse the result text"
condition:
  - 'JSON\.parse\s*\('
scope: tool:bash
interruptMode: never
---
**Tool-result text is not JSON.** It carries a `Wall time` trailer, and large output is truncated into an artifact, so `JSON.parse` on tool-result text cannot succeed — one measured turn repeated exactly this failure for 2h (LOOPGUARD1, ompkit-xa5s.18).

Parse inside the command with jq instead (e.g. `br show <id> --json | jq '.title'`), or parse the captured stdout of a subprocess. Never feed tool-result text to a JSON parser.
