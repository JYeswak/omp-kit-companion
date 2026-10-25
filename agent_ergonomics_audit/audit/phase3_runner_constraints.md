# Phase 3 replay contract and runner defects

Consumer: ERGO1 phase-4 recommendations and audit evidence readers. This replaces the prior NOT RUN note; execution results are recorded separately in phase3_results.md and the corpus. Retire with the next superseding audit.

## Current invocation contract

The fixed installed runner is invoked as:

`TMPDIR=/Users/josh/Developer/omp-kit-companion/var/agent-tmp/aergo-p1c.28881 AERG_PROBE_TIMEOUT=30 nice -n 10 bash /Users/josh/.agents/skills/agent-ergonomics-and-intuitiveness-maximization-for-cli-tools/scripts/run_intent_corpus.sh /Users/josh/Developer/omp-kit-companion/agent_ergonomics_audit /Users/josh/Developer/omp-kit-companion/agent_ergonomics_audit/bin/omp-kit-src`

One runner, no parallel target probes. Script wall deadline: 600 seconds. The runner honors AERG_PROBE_TIMEOUT and TMPDIR (current installed script lines 284–291), so the previous note asserting hardcoded five seconds and unconditional /tmp is stale. No alternate binary, guard bypass, skill repair, source edit, test or build was introduced.

Full script stdout/stderr and actual script exit are `phase3_runner.stdout.log`, `phase3_runner.stderr.log`, `phase3_runner.exit`. Per-entry output lives in intent_inference_corpus.jsonl; excerpts may be truncated by the runner. The raw completed result is preserved as phase3_runner_raw.jsonl before audit normalization.

## Installed runner defects / limitations for skill_defects.md

1. Safety check (around lines 210–216): safe_to_run=false alone does not block an entry unless mutates=true. Audit input marks all excluded rows as potential mutation/scope risk plus false safety and attaches audit_safety_reason. A false safety assertion must not be interpreted as an execution prohibition by this runner without that additional mutation flag.
2. Skips initialize exit_code=0 (around line 207), then serialize it as if an exit occurred (around lines 326–344). Audit normalization changes only skipped rows to exit_code=null, retains runner_exit_code=0 for transparency, and sets executed=false with a concrete safety reason. Executed rows retain the actual runner exit and executed=true.
3. Successful nonempty output is always inferred_and_acted (classify around lines 148–189), without checking intended semantics. Generic --help pointers can count as useful_hint despite the stricter subagent rubric. See phase3_classification_limitations.md; these are raw heuristic labels, not evidence of task success.
4. External timeout's status is not independently disambiguated from a target's natural timeout-like exit; stderr/stdout are buffered unbounded before 4096-character truncation. Full script logs do not restore truncated target streams.
5. Installed corpus JSON schema requires integer exit_code; truthful skipped nulls are intentionally retained. No gate is weakened and no fabricated 0 exit is supplied to make schema validation pass.

Generator outcomes/defects and concurrency uncertainty are in phase3_generator_notes.md. No skip claim about the old refused scratch wrapper is carried into the replay inputs. Any actual target/wrapper refusal observed in the completed run is runtime evidence, not an invented skip.
