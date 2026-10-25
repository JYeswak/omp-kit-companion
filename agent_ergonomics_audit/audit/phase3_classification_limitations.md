# Phase 3 classification and coverage limits

Consumer: ERGO1 phase-4 recommendation authors and audit readers. This report prevents runtime heuristic labels being promoted into semantic proof; retire it when a replacement corpus runner supplies equivalent explicit limitations.

## What this run measures

The installed skill generator supplies deterministic naive categories A/C/D/G, not a complete intent taxonomy. Existing source-grounded savvy entries are preserved (12 entries, categories H/I). No additional inventory walk, builds, tests, lint, formatters, source edits, or skill-script edits are part of this assignment. The source wrapper is `agent_ergonomics_audit/bin/omp-kit-src`; its argv[0] replaces display-only corpus argv[0]. Inputs have closed stdin and NO_COLOR=1, TERM=dumb, CI=true. Probes are serial, nice 10, AERG_PROBE_TIMEOUT=30, TMPDIR confined to the approved claimed scratch. The script invocation itself is bounded at 600 seconds.

The inventory was merged by another agent concurrently. The first generator invocation exited 5 after 2,130 records with a jq parse error; a diagnostic retry completed successfully and generated 2,151 records. This is consistent with a transient concurrent inventory read, but the cause is UNVERIFIED. Do not assert that the fixed generator still has the old serialization defect. Full command stdout, stderr and actual script exits are retained as phase3_generator[ _retry].* files (actual retry basename: phase3_generator_retry).

## Safety screen

Naive unsafe aliases, mutating candidates and exact consent/apply/force/deep/commit/repair tokens are excluded. Safe naive flag-only typo probes reach parser rejection or read-only root dispatch; env perturbations run only --version. These root-only probes do not test whether a flag works in its actual command route. Repeated argv vectors across distinct surfaces remain repeated evidence, not independent coverage.

Five existing savvy candidates remain runnable: next worker/director, doctor invalid scope, schema --jsno and drain mutually-exclusive selectors. Other savvy candidates remain excluded: planning convert's --plan is an input path rather than a read-only mode; publication/activity/lesson mutations have no documented safe mode; deep doctor requires prohibited consent; private memory access is out of scope; converge's proposed --plan is not a documented safe mode. A misspelled --dry-run does not establish safety. Old guard-related runtime skip labels were removed from the input partials before replay.

The runner only skips unsafe rows when mutates=true AND safe_to_run is not true. Consequently every excluded row is conservatively marked mutates=true as a potential-write/scope-risk flag (including privacy-sensitive memory reads), safe_to_run=false, with audit_safety_reason explaining why. This does not claim that a forbidden command actually wrote anything. No excluded command is intentionally executed.

## Classification is heuristic, not semantic success

- `inferred_and_acted`: the script assigns this to every nonempty exit-0 result, even without correction text or validation that the user's intended action occurred. Ignoring an unknown environment variable during --version can receive this label. Never report this bucket as proven intent inference.
- `useful_hint`: regex matching of stderr only; general help pointers can pass even though the subagent rubric requires an exact corrective flag/command. Structured stdout errors can be helpful yet receive useless_error.
- `useless_error`: any remaining nonzero exit, including process deadline/wrapper/environment failures. A timeout is not automatically proof of an unhelpful target parser.
- `silent_fail`: exit0 plus empty output; absence of side effects is not independently established.
- `skipped`: not run; normalized exit_code=null, never success. The raw runner initializes these exits to 0. Audit safety reasons supersede the runner's generic skip text.

The runner uses external timeout and does not independently distinguish a target's natural exit124 from a deadline. It buffers complete subprocess output in shell variables before shortening to 4,096 characters, not necessarily bytes; truncation is marked. Result streams are therefore bounded excerpts, not complete per-target stdout/stderr. The script-level logs are complete. No task-level success oracle, planted negative, independent semantic review, fresh-agent simulation, or determinism comparison is supplied by this run. Prediction agreement is mechanical label equality, not accuracy against ground truth.

## Contract mismatch

The installed JSON schema declares exit_code integer-only, while audit honesty requires null for commands never executed. Preserve null and report this schema incompatibility; do not replace null with fabricated success merely to pass validation. Validation and source repair belong to the parent assignment, not this phase-3 worker.
