---
description: "Tool-result text is not JSON: parse inside the command with jq, never JSON.parse the result text"
condition:
  # Quiet when JSON.parse sits in a command segment whose command word is echo/printf
  # (metamorphic quoting relation). A segment starts at the input, the JSON command value,
  # ; & | newline backtick, $( or an unescaped JSON \n. The lookbehind follows the literal and is
  # bounded (64 spaces, 256 segment chars), so its cost is constant per JSON.parse: the unbounded
  # form measured quadratic. Tradeoff: an echo more than 256 segment chars before JSON.parse is
  # not seen and the rule still fires, as it did before. Pinned by
  # tests/cli/echo-literal-rules.test.ts.
  - 'JSON\.parse(?<!(?:^|"command"\s{0,8}:\s{0,8}"|[;&|\n\x60]|\$\(|(?<!\\)(?:\\\\){0,32}\\n)\s{0,64}(?:echo|printf)\b(?:[^;&|\n\x60$\\]|\$(?!\()|\\[^n]){0,256})\s*\('
scope: tool:bash
interruptMode: never
---
**Tool-result text is not JSON.** It carries a `Wall time` trailer, and large output is truncated into an artifact, so `JSON.parse` on tool-result text cannot succeed — one measured turn repeated exactly this failure for 2h (LOOPGUARD1, ompkit-xa5s.18).

Parse inside the command with jq instead (e.g. `br show <id> --json | jq '.title'`), or parse the captured stdout of a subprocess. Never feed tool-result text to a JSON parser.

A command that only prints the text `JSON.parse(` (`echo`, `printf`) parses nothing and stays quiet.
