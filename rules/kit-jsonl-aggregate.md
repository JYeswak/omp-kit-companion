---
description: "DAILYCLASSES: refuse array grouping of individual tracker issue objects in read JSONL queries"
condition:
  - '\.beads/issues\.jsonl\?q=(?:group_by\s*\(|\{[^|\r\n]*group_by\s*\()'
scope: "tool:read"
interruptMode: always
---
kit-jsonl-aggregate: read applies a JSONL query to each issue object, not to an array of issues. Top-level group_by therefore fails before producing the requested inventory. For cross-record grouping use `jq -s 'group_by(.status)' .beads/issues.jsonl`; preserve the rest of your aggregate expression after slurping. Per-record field queries and grouping an explicit nested array are unchanged.
