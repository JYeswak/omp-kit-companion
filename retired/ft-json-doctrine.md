---
condition: '\S'
scope: tool:edit(*.json), tool:write(*.json)
interruptMode: never
repeatMode: once
---
Retired: the JSON file-type trigger delivered generic redaction advice, not a check tied to the actual payload. Its bind rate was not measured. The name remains here so the installer can retire an older installed copy; see `REASONS.tsv`.
