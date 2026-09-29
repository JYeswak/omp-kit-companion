---
condition: '\b(is|are|was|were)\s+not\s+(installed|configured|wired|enabled|available|present|running|reachable|mounted|registered|discovered)\b|\b(key|token|credential|secret|binary|command|tool|server|index|hook|extension|skill|package|module|dependency|mcp|api|daemon|corpus|database|endpoint)\b[^.!?\n]{0,50}\b(is|are|was|were)\s+(missing|absent|unset|not\s+(set|found))\b'
scope: text
interruptMode: never
repeatMode: after-gap
repeatGap: 10
---
**You are about to assert ABSENCE. Name the probe that produced it, and name a second one that could have found it.** A negative result from one probe is `UNMEASURED`, never `ABSENT`.

An older private set of session notes recorded several false absence claims:

- A shell binary probe reported an MCP-only capability missing; the probe could not see MCP servers.
- A key was reported missing after checking a single file and environment variable; the configured secret store had it. Do not publish key names or secret paths as evidence.
- An empty `ee tripwire list` was mistaken for unavailable preflight; inspecting the relevant source showed an empty-match return path while another configuration triggered matches.
- `get_state` listed no MCP tools, but the command does not enumerate MCP tools. That negative result could not establish absence.

These historical observations are not independently reproducible from this public pack.

Before the claim ships, one of these must be true:
1. **Two probes of different kinds disagree with absence** — a binary AND a config surface, a file AND a service, a CLI AND its source.
2. The claim is downgraded to `UNMEASURED (probe: <the exact command>)`.
3. You read the code that would have to contain it.

INVARIANT rule: it never asserts you are wrong, only that you name the probe.

**Measured 2026-09-20 in the corpus that can actually see prose** — 1,841 omp session JSONL files, **45,103 assistant-text turns**, not the 78,242-record bash harvest, which is `tool=bash` only and is blind to this class. Shipped predicate: **185 fires, 0.4102%**. Hand-labelled n=20, seed `20260920`, one labeller: **FP 0.20** — the four false ones were absence of *data* (bead ownership state, text spacing, mutation coverage, a matrix row), never of a capability.

**Two tiers were measured and REFUSED, and dropping them removed 66% of all fires:**
- `no such` / `does not exist` — **332 fires, 0.7361%**, the single largest source and almost entirely *file-path* claims, where one `ls` genuinely is sufficient. A rule that fires there teaches readers to ignore it.
- `NOT INSTALLED` / `returned MISSING` (7) and uppercase `… is missing` (47) were below the 50-occurrence floor in that private sample. A different project-local rule handled the credential-routing case there; that rule is not part of this pack. Do not lower the floor to accommodate one anecdote.

RETIRE when a 30-day window over the same corpus shows this predicate below 50 occurrences.
