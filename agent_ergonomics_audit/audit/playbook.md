# ERGO1 runtime audit and Phase5 implementation playbook

## Scope and evidence authority

This run finishes the requested Phases1–4 artifacts only. No product code, tests, releases or skill source changed; no commits. All recommendations remain unapplied. Full bead acceptance is still open: implementing ten changes, release/install proof and fleet-week measured turns are not audit outcomes.

Evidence: `runtime_inventory_evidence.jsonl` preserves the supplied help walk (not rerun); `phase4_runtime_probes.jsonl` captures five serial real-checkout discovery invocations. `intent_inference_corpus.jsonl` captures safe executed mistakes and explicit skips. Source citations in `recommendations.jsonl` remain source evidence, not retroactively upgraded by a successful help probe. `runtime_target_fingerprints.json` identifies observed checkout files; this is not exact-release certification.

Mechanical score validation and rubric agreement are separate. The original 56 A/B disagreements ≥500 remain; do not claim consensus or measured uplift. Two independent runtime-help reviews update changed evidence, preserving independent source scores elsewhere. Final counts, medians, validator result and corpus outcomes are in `phase4_summary.md`.

## Ranking

Priority = frequency × gap × blast radius, stored as a raw product. Gap = (1000 − worst associated aggregated weighted score)/1000. Blast radius is a declared judgment. VALUE1 capture has321 runs/33 literal omp-kit mention-shapes; one compound tracker workflow supplies58/321 exposure for R-001/R-003 only. It does not establish either verb's frequency or defect rate. Other recommendations have zero observed attributable runs, not zero true use. Corpus repetitions are not frequency evidence.

|Rank|ID|Priority|Decision|
|---:|---|---:|---|
|1|R-003|0.0466168224|Semantic next-station hint before edit-distance guesses|
|2|R-001|0.0343302181|Portable role-aware `omp-kit next` mega-command|
|3|R-002|0, tied|Bare invocation becomes discovery, without hiding explicit status failures|
|4|R-008|0, tied|Preserve all equals suffixes in attached values|
|5|R-006|0, tied|Publish route-specific exit contracts without renumbering|
|6|R-009|0, tied|Pin and extend existing schemas/output modes|
|7|R-005|0, tied|Distinguish missing dependencies from unwired handlers|
|8|R-004|0, tied|Concise automation/exit pointers in existing help|
|9|R-011|0, tied|Protect current streams and non-TTY refusal behavior|
|10|R-012|0, tied|Portable measured ergonomics push gate|

Zero-product ordering retains the earlier risk/contract tie-break; it is not a measured preference. Concrete diff sketches, affected surface IDs, citations, plausible regression behaviors, risks and hypothetical per-dimension uplift remain in `recommendations.jsonl`. Do not sum overlapping hypothetical uplift as a measured gain.

## Existing behavior to reuse

- Root help, capabilities, schema and robot-docs all execute successfully. Capabilities/schema emit one parseable JSON envelope with rc0. This is not a missing-introspection project.
- Bare invocation returns rc1 with plugin-link drift and exact remediation on stderr. It neither hangs nor launches a TUI. R-002 changes discovery policy; status must continue reporting the finding truthfully.
- Help advertises JSON/robot and related discovery verbs but has no dedicated automation/exit dictionary section. Keep R-004 short; do not dump another registry into help.
- Capabilities publishes success0, finding1, usage_or_blocked2, unavailable3, retryable4, not_run77. R-006 adds custody/heavy/raw-child route semantics; it must not impose another tool's exit meanings.
- Existing nearest-match logic already suggests some typos. R-003 is about semantic correctness, not claiming typo recovery is absent.
- Shared renderer owns structured output. JSON errors can be data in stdout; human errors use stderr. Do not install a gate that rejects every structured error or legitimate nonzero finding.

## Safe implementation order and acceptance

1. **R-008 parser loss**: in `src/cli.ts` split attached values at the first equals with index/slices, not a two-element split. Test attached and separate argv with `a=b=c`, empty-value refusal and boolean attached-value refusal. Current runtime does not independently establish this bug; retain the source citation until the regression reproduces it.
2. **R-006/R-009 contract metadata**: extend `src/commands.ts` output/exit metadata; export through existing capabilities/schema handlers. Preserve envelope fields and raw/JSONL route exceptions. Pin nested consumer-relevant types, not source copies or exact prose.
3. **R-001 next**: register top-level `next --role worker|director --json`, wire existing stock diagnostics and optional bounded adapters. Built-but-unwired is not available. No mandatory br/Tern/AgentMail/cc. Missing/stale/timed-out adapters report UNKNOWN with null counts, not invented healthy queues. Never claim, send, dispatch, close, acknowledge or mutate in a read command. Pure followups carry authoritative argv arrays; shell-quoted display is not executable policy.
4. **R-003 semantic suggestions**: tiny explicit registry-valid intent mapping before nearest(). Until next is admitted, say unavailable and point to exact status/capabilities discovery; never suggest unrelated test for next. Never execute corrections automatically. Preserve ambiguity refusal and redact secrets.
5. **R-002 bare behavior**: bare human argv returns concise help rc0 after the explicit scope decision. Keep explicit status and existing machine-flag-only behavior. No fleet/network aggregation on bare invocation; do not suppress OMP/profile failures.
6. **R-005/R-004 availability and help**: derive reason once, distinguish missing tool from unwired handler, retain runnable-only catalog semantics and add precise unavailable metadata. PATH existence is not health. Add exact help pointers without claiming absent functionality.
7. **R-011 stream/non-TTY regressions**: use closed stdin, separate streams, command-specific expected exits and env modes individually. Five combined-env discovery probes are not comprehensive TTY/consent verification. No mutation just to check a prompt.
8. **R-012 gate**: one portable bounded runner using platform/Bun defaults, optional fleet adapters only. Explicit safe argv allowlist; do not execute all registry examples (robot-docs contains mutations). Check parseability, stream separation, deterministic stable routes with declared volatile pointers, non-TTY behavior, schema compatibility, documented exits and exact typo correction. Negative/control pairs must distinguish genuine errors from legitimate nonzero findings. Never blanket-strip timestamps, regenerate goldens, or accept repeated refusal as success. Measure incumbent push plus proposed gate in the same invocation; cost is currently UNMEASURED, not cheap by assertion.

Remaining R-013/014/015/016 target confirmation grammar, unsupported uninstall recovery advice, unexpected-failure output and standalone --info metadata. Help-only exposure does not prove these behavioral defects. R-007 extends local typo coverage; R-010 declares precise determinism boundaries. No uninstall, rollback, apply or yes invocation ran in this audit.

## Corpus interpretation and skill defects

Use exact captured commands/exits, not the classifier label alone. Generic help pointers are weaker than exact corrections. Exit0 version output with an ignored misspelled env variable is not demonstrated inference. Skips have null exit codes. Unsafe aliases and mutation candidates lacking a documented safe preview stay skipped.

`skill_defects.md` and phase3 notes document runner safety metadata, skip exits, classifier limitations and generator coverage. Full script output and actual producer exits are retained. No skill edits or bypass were made. A failed script is not a passing phase; a subsequent completed invocation is identified separately.

Side-effect limit: source inspection identifies best-effort `ccSpool`/`ccEmit` telemetry even for parse errors/version (`src/cli.ts:4459-4461,4492-4497` at this checkout). No explicitly mutating command was executed, but absence of automatic telemetry writes was not verified. Do not claim the target process was filesystem-side-effect-free.

## Promotion boundary

Use `phase4_summary.md` and `phase1_4_status.json` for current artifact status, not the historical source-only blocker notes. Resolve the rubric-consensus halt before treating these scores as an accepted baseline. Phase5 must prove consumer behavior before/after; independent exact-revision acceptance and installed-release proof remain separate work. This audit neither closes ERGO1 nor certifies the future push gate.
