# next

```sh
omp-kit next --role worker --repo PATH --agent NAME --json
omp-kit next --role director --repo PATH --json
```

Read-only guidance, not an executor. `--role` is required (`worker` or `director`); repository defaults to the working directory and agent to `AGENT_NAME`. Never claims, sends, acknowledges, reclaims or closes work. Recommended commands are strings for inspection; none runs automatically.

Worker order: broken blocks DAG / blocked without an open blocks fix; held in-progress work; another seat's review; own rework; BV-ranked native-ready pick; top blocked research. Publish, pending acknowledgements and scratch inspection follow. One candidate per station keeps the human view short. A claim recommendation first asks for fresh native readiness and bead inspection; it is not claim authorization.

Director consumes producer fields for blocked-without-fix, stale in-progress, idle workers with ready supply, and review count/oldest age. Stale work still requires checking for a live holder before reclaiming. The hourly REPORT obligation is labeled with UNKNOWN last-delivery evidence; it does not assert that a report was delivered or missed.

JSON uses the standard envelope. `data` has exactly `role`, `next_action`, `actions`, `facts`, `adapters`, `applicable_skills`; envelope `commands` equals `next_action.commands`. Each action contains `station`, a source-bearing `why`, and shell-quoted command strings. Human output puts NEXT first, then one line per remaining action and applicable skill.

Facts carry `status`, `source`, and `value`; UNKNOWN means `value: null` plus a reason, never an empty healthy queue. Adapter summaries carry status/source and failure reason. Missing tools, nonzero exits, truncated output, timeouts, and unsupported JSON shapes are UNKNOWN and do not fail the command. Stock checkouts get git inspection/publish guidance without fleet prerequisites. Exit 0 means answered, not healthy; exit 2 means invalid role.

Subprocesses have 10-second deadlines, closed stdin, bounded capture and process-group cleanup. The blocked-detail adapter performs at most two bounded reads (20 seconds total); other adapters run concurrently. Change collection performs four concurrent bounded git reads. Native br calls disable automatic import/export; BV reads the JSONL export, never the live database.

## Applicable skills

`config/skill-stations.toml` is the canonical station map. Each `applicable_skills` entry is `{skill, station, mandatory, trigger, why}`. These are review recommendations, not proof that a skill was applied or its artifact verified; this consumer does not refuse a land.

The `changes` adapter reads `git diff --name-only -z HEAD` and the corresponding full-context patch in `--repo`, plus names and patches from `origin/main...HEAD` for unpushed commits. It includes staged and unstaged tracked changes; untracked files are outside `git diff HEAD`. External diff/textconv helpers are disabled. An unavailable baseline, failed read, truncation or timeout makes the change set UNKNOWN, not an examined empty set.

Decidable matches include mission/ADR/domain/build-contract/prose/skill paths, added default migration-path candidates, literal JS/TS regex changes, and changed `package.json` bin strings/maps. Bin declarations nominate mandatory agent-ergonomics review without certifying operator-facing CLI classification or reachability. The regex adapter validates complete supported JS/TS hunks with Bun's native transpiler, then recognizes literals in unambiguous expression-start contexts (including assignment, arguments and return) while skipping strings/comments; templates, JSX, ambiguous slash contexts, partial hunks, constructors, dynamic patterns and other languages remain UNKNOWN rather than guessed negatives. Prose-only paths yield no mandatory matches.

Log-, timing-, intent-, manifest- and trace-dependent detectors remain UNKNOWN. Mandatory UNKNOWN rows appear in envelope warnings and are not exemptions; they are not inserted into the matched `applicable_skills` array. Read the warnings and `facts.changes` before interpreting an empty array.

Validation rejects empty detectors, duplicate `(station, trigger)` keys, mandatory rows without rule citations, invalid station/skill names and malformed map structure. Every referenced skill is checked for `~/.claude/skills/<skill>/SKILL.md` at runtime. Missing/unreadable skills are reported as `MISSING_SKILL` warnings and never make `next` fatal or remove an otherwise applicable recommendation. The checked-in draft's inventory count/digest are provenance, not a live inventory.

## Adapter limits

The current fleet-pulse producer creates scratch/cache state, and sitrep writes history even with `--json`. `next` detects those optional scripts but refuses to execute them: UNKNOWN with the reason. Director snapshot injection is supported through the exported `Adapters` interface; live director metrics require genuinely read-only producers. No duplicated fleet metric implementation is used.

The installed `am acks pending` emits a table, not JSON. Its adapter reports UNKNOWN for that unsupported shape; it never substitutes an inbox fetch that marks messages read. A compatible JSON-emitting adapter supplies pending acknowledgement rows. Scratch-plan timeouts likewise remain UNKNOWN; plan entries are inspection candidates, not disposal permission.

Implementation/test seams: `next(options, adapters)`, `realNextAdapters()`, bounded `command(...)`, and `formatNext(data)`. The registry and CLI dispatch are integrated separately by the lead.
