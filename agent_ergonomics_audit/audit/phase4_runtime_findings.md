# Runtime discovery findings

Evidence: `phase4_runtime_probes.jsonl`, five serial real-checkout probes through committed `bin/omp-kit-src`, closed stdin, NO_COLOR=1, TERM=dumb, CI=true, nice 10, 30-second deadline. These are source-wrapper observations, not installed-release certification. Target hashes: `runtime_target_fingerprints.json`.

- Bare invocation: exit 1, empty stdout, REQUIRED_FINDING_FAILED on stderr with plugin-link drift and exact remediation. This is a real health finding, not a crash, silent failure or TUI. R-002 remains an explicit change from health checking to discovery; do not suppress the finding in `status`.
- `--help`: exit 0. Existing capabilities/schema/robot-docs, JSON/robot flags and help TOPIC are discoverable. No dedicated automation/exit dictionary section. R-004 is incremental, not a missing-help claim.
- `capabilities --json`: exit 0, exactly one parseable envelope. data exposes commands, exit_codes, global_flags, proof_classes, schema_version, tool_version. Published dictionary is success=0, finding=1, usage_or_blocked=2, unavailable=3, retryable=4, not_run=77. R-006 asks for route-specific extensions, not renumbering.
- `schema --json`: exit 0, exactly one parseable envelope. R-009 must extend/pin the existing introspection rather than introduce a second robot schema.
- `robot-docs guide`: exit 0; status, capabilities, examples and consent warnings already exist. Its examples include mutations; this audit did not execute them. R-012 cannot execute every example indiscriminately.

Limits: one environment combination is not independent coverage of each env variable; no TTY behavior, mutation consent, deterministic re-execution, release install, or future gate performance was proven by these five probes. Help runtime evidence proves advertised grammar, not handler effects. Recommendations remain unapplied.

## Captured typo counterexamples

`intent_inference_corpus.jsonl` naive-001/003/004/005: misspellings of --json exit2 with exact `Use --json exactly` correction. Existing typo handling is real.

naive-002: `--josn` exits2 with only `Run omp-kit --help for valid flags`; stock runner labels it useful_hint, but the rubric's exact correction is absent.

naive-007: the --robot perturbation `--root` collides with another known flag and exits2 with `--root needs PATHS`. This is a useful syntax hint for the wrong intent, not demonstrated robot recovery. No corrected command was executed.

Across the complete corpus,679 raw useful_hint rows contain only the generic `Run omp-kit --help for valid flags.` after UNKNOWN_FLAG;111 rows are the --root/--robot collision. All16 inferred_and_acted rows are --version probes with misspelled env variables, not demonstrated detection/recovery. Counts include repeated argv and are not independent defects.

`phase4_semantic_next_probe.json`: bare `next` exits2 with `UNKNOWN_COMMAND: Unknown command: next` and `Try omp-kit test exactly; no command was run.` This directly demonstrates R-003. Savvy001/002 instead fail earlier on unknown --role; they do not reach this branch.
