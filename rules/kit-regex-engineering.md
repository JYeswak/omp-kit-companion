---
description: "Use the regex-engineering workflow before adding a regular expression"
condition:
  - 'new\s+RegExp\s*\(|\/(?![/*])(?=([^/\\\n]*))\1(?:\\.(?=([^/\\\n]*))\2)*\/[dgimsuvy]*\.test\s*\(|\.(?:match|replace|split)\s*\(\s*/|re\.(?:compile|search|match|sub|f(?:ind(?:all|iter)|ullmatch))\s*\(|Regex::new\s*\(|condition:'
scope:
  - 'tool:write(**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts,py,rs})'
  - 'tool:edit(**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts,py,rs})'
  - 'tool:write(rules/*.md)'
  - 'tool:edit(rules/*.md)'
interruptMode: never
---
**Before adding or changing a regular expression, read the `regex-engineering` skill first and complete its §7 Verify checklist.** Run the pattern in the engine that ships it; include a required match, a reject/boundary case, and a timed long near-miss; run regexploit for backtracking risk. For untrusted inputs, cap input length or choose a linear engine where possible. Don't claim speed without measured results. This is a reminder, not enforcement: firing does not prove the skill was applied; the gates prove it.
