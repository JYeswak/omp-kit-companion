---
description: "Read regex-engineering before a dynamic constructor or nested quantifier"
condition:
  # Check the constructor head before scanning nearby checklist exclusions.
  # Every dynamic new RegExp match necessarily has this head; ordinary "new" does not.
  - 'new(?=\s+RegExp\s*\()(?<!regexploit[\s\S]{0,40})(?<!regex-engineering[\s\S]{0,40})(?![\s\S]{0,80}regexploit)(?![\s\S]{0,80}regex-engineering)\s+RegExp\s*\(\s*[A-Za-z_$]'
  - 're(?<!regexploit[\s\S]{0,40})(?<!regex-engineering[\s\S]{0,40})(?![\s\S]{0,80}regexploit)(?![\s\S]{0,80}regex-engineering)\.(?:compile|search|match|sub|findall|finditer|fullmatch)\s*\(\s*[A-Za-z_]'
  - 'Regex(?<!regexploit[\s\S]{0,40})(?<!regex-engineering[\s\S]{0,40})(?![\s\S]{0,80}regexploit)(?![\s\S]{0,80}regex-engineering)::new\s*\(\s*[A-Za-z_]'
  - '\((?<!regexploit[\s\S]{0,40})(?<!regex-engineering[\s\S]{0,40})(?![\s\S]{0,80}regexploit)(?![\s\S]{0,80}regex-engineering)[^)\n]{0,40}[+*]\)[+*{]'
scope:
  - 'tool:write(**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts,py,rs})'
  - 'tool:edit(**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts,py,rs})'
  - 'tool:write(rules/*.md)'
  - 'tool:edit(rules/*.md)'
interruptMode: never
---
**Before adding a dynamic regular expression or a nested quantifier, read the `regex-engineering` skill and complete its §7 Verify checklist.** Run the pattern in the engine that ships it; include a required match, a reject/boundary case, and a timed long near-miss; run regexploit for backtracking risk. An ordinary literal, a static `new RegExp("...")`, or a constructor with `regex-engineering` or `regexploit` next to it stays quiet. This is a reminder, not enforcement: firing does not prove the skill was applied; the gates prove it.
If a regular expression is being used as a quote-aware parser or tokenizer, also read the `ast-parsing-engineering` skill.
