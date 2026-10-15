---
description: "ompkit-fp72.8: heavy REA JavaScript analysis needs minute-scale waits, the 600 s server timeout, and detail summary first — never shrink analysis limits or retry a resource_constraint without summary"
condition:
  # Fire: shrinking the isolated-analysis limits below their defaults (timeout default 300000,
  # heap default 1024), or retrying after a resource_constraint without asking for summary.
  # - analysis_timeout_ms below 300000: 1-5 digits, or 6 digits starting 1-2, never part of a
  #   longer run (so 1200000 stays quiet); 300000 and above stay quiet. A trailing word is
  #   required so streamed mid-number prefixes stay quiet until the value is complete.
  # - max_heap_mb below 1024: 1-3 digits not part of a longer run, also with a trailing word;
  #   1024 and above stay quiet.
  # - resource_constraint with no summary within 200 chars after stays fire; a retry naming
  #   detail summary stays quiet.
  - 'analysis_timeout_ms["'']?\s*:\s*(?<![0-9])(?:[0-9]{1,5}|[12][0-9]{5})(?![0-9])\s+\S'
  - 'analysisTimeoutMs["'']?\s*:\s*(?<![0-9])(?:[0-9]{1,5}|[12][0-9]{5})(?![0-9])\s+\S'
  - 'max_heap_mb["'']?\s*:\s*(?<![0-9])[0-9]{1,3}(?![0-9])\s+\S'
  - 'maxHeapMb["'']?\s*:\s*(?<![0-9])[0-9]{1,3}(?![0-9])\s+\S'
  - 'resource_constraint(?![^\n]{0,200}summary)'
scope: text
interruptMode: never
---
Heavy REA JavaScript analysis takes about a minute and answers through evidence, not chat text: the MCP server timeout is 600 s, the isolated-analysis defaults are 300000 ms and 1024 MiB, and large results must be asked for with detail summary first, then read via inspect_analysis_view or export_evidence_bundle. Shrinking analysis_timeout_ms or max_heap_mb below the defaults, or retrying the same full call after a resource_constraint instead of requesting summary, turns a successful analysis into a failure. Calls that already ask for summary, keep the defaults, or raise the limits stay quiet.
