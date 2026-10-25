# ERGO1 Phases1–4 runtime summary

## Scope and counts

- Audit-only continuation for ompkit-rc-epic-land-fix-release-dogfood-rz5.112. No src/tests edits, implementation or commits. This does not close the full bead.
- Inventory:2,506 surface records; all2,504 existing IDs retained, two newly observed flags added. Supplied runtime inventory reused, not rerun:720 rows (76 verb/644 flag rows), deduplicated/joined to555 unique surfaces. Runtime help is not handler execution.
- Runtime-help evidence:555 HELP_VERIFIED,1,951 UNVERIFIED with explicit reasons. Source-only schema/config fields and inherited flags are not independent runnable tasks. Durable raw evidence: runtime_inventory_evidence.jsonl.
- Runtime rescore:555 surfaces in each of two independent reviewer passes; original independent A/B judgments retained outside changed evidence. Official aggregator output is agent_surfaces.jsonl. Rubric v1.0.0.
- Preserved disagreement:56 surfaces have spread≥500 (rubric halt),247 have300–499 (third-scorer review required),606 have200–299 warnings,1,597 have<200. Mechanical validation is not consensus; accepted Phase2 baseline remains unresolved.
- Six parent probes: bare rc1; help/capabilities/schema/robot-docs rc0; bare next rc2. See phase4_runtime_probes.jsonl and phase4_semantic_next_probe.json.
- Recommendations:16, all unapplied. Required R-001/R-002/R-003/R-012 retained. All620 surfaces below weighted-score Q1=534 have a shared remediation candidate; candidates are not per-surface confirmed defects.

## Median per dimension (0–1000)

These are A/B rubric medians, not performance, turns saved, measured uplift or consensus. Weighted-score median:554. The population contains1,245 config/schema fields.

|Dimension|Median|
|---|---:|
|agent_intuitiveness|550|
|agent_ergonomics|525|
|agent_ease_of_use|525|
|output_parseability|600|
|error_pedagogy|400|
|intent_inference|375|
|safety_with_recovery|1000|
|determinism_and_reproducibility|550|
|self_documentation|600|
|composability|625|
|regression_resistance|250|

### Surface-class denominators

|Kind|Records|Median weighted score|
|---|---:|---:|
|config|1245|554|
|env|37|422|
|error|199|502|
|exit|11|579|
|flag|902|590|
|prompt|1|552|
|verb|111|536|

## Corpus outcome table (stock heuristic labels)

|Generator|Rows|Executed|Silent fail|Useless error|Useful hint|Inferred/acted|Skipped|
|---|---:|---:|---:|---:|---:|---:|---:|---:|
|naive|2151|2149|0|1|2132|16|2|
|savvy|12|5|0|4|1|0|7|
|Total|2163|2154|0|5|2133|16|9|

Actual process exits:16×0,2,138×2. All9 skips have null exits and explicit reasons; no process ran for them. No executed argv contains --apply/--yes or a declared mutating entry. nice10, AERG_PROBE_TIMEOUT=30, closed stdin, serial execution; runner exit0. Full producer outputs: phase3_generator.*, phase3_generator_retry.*, phase3_runner.*; unnormalized runner rows: phase3_runner_raw.jsonl.

Naive2,151 rows represent360 unique argv/env/cwd combinations and1,791 duplicates;899 surface IDs. Do not interpret raw counts as independent trials.679 useful_hint rows have only generic help;111 are the --root/--robot collision; all16 inferred_and_acted rows merely print version under misspelled env keys. Two structured JSON savvy refusals contain actionable corrections but are labeled useless_error because the classifier inspects stderr only. Bare next independently suggests unrelated test; role variants instead fail earlier on --role.

Coverage limits: all2,506 surface records score<700 on intent;226 have≥3 corpus entries,682 have1–2,1,598 have none. No fresh-context canonical-task simulation was run. The requested fixed generator plus preserved savvy replay completed, not every exhaustive Phase3 methodology criterion. Automatic telemetry side effects were not independently ruled out.

## Top10

Priority=frequency×(1000−worst associated weighted score)/1000×blast radius. R-001/R-003 use58/321 candidate-workflow exposure only, not verb prevalence or failure incidence. All other frequencies are zero observed attributable runs, not zero true usage; equal-zero priorities remain tied in prior risk/contract order.

|Rank|ID|Priority|Recommendation|
|---:|---|---:|---|
|1|R-003|0.0466168224|Use semantic next-station hints before edit-distance guesses|
|2|R-001|0.0343302181|Add portable role-aware next mega-command|
|3|R-002|0.0000000000|Decide bare help exit0 versus existing presence status|
|4|R-008|0.0000000000|Preserve equals inside attached flag values|
|5|R-006|0.0000000000|Publish complete route-specific exit categories|
|6|R-009|0.0000000000|Pin additive schemas and explicit output modes|
|7|R-005|0.0000000000|Distinguish missing dependencies from unwired handlers|
|8|R-004|0.0000000000|Add concise automation and exit pointers to help|
|9|R-011|0.0000000000|Pin existing streams and non-TTY protections|
|10|R-012|0.0000000000|Design portable measured ergonomics push gate|

Concrete diff sketches, citations, risks, hypothetical uplift and test plans are in recommendations.jsonl; safe dependency-aware implementation order is in playbook.md. Corpus agent independently reviewed the parent synthesis: no concrete errors found (phase4_review.md); that does not independently verify its own corpus or resolve scoring disagreement.

## Script and promotion limits

Full aggregation exceeded600 seconds after2,317 rows; continuation uses the same canonical aggregator per remaining surface. First corpus generation exited5, diagnostic retry exited0; concurrent inventory rewrite is a possible cause, not a proven remaining serialization defect. Other skill safety/classification/schema/coverage defects are in skill_defects.md. Scorecard validator full output and exact exit belong to phase2_validator.md/partial validation records, not an inference from score presence.

Scores and plots are provisional rubric views. Phase2 consensus remains HALTED despite mechanical validator exit0. Installed release, independent exact-revision verification, ten implemented changes, gate performance and fleet-week turns-per-task remain unverified and outside this artifact-only run. No gate was weakened, no disagreement removed, no uplift claimed.

## Exercised artifact verification

- Full `tools/validate_scorecard.sh audit/agent_surfaces.jsonl` completed in318.634s, exit0, stdout exactly `validate_scorecard: OK\n`, stderr empty. Complete output/argv: `partial/phase2_validator_output.json`. This validates all2,506 final rows, not a subset.
- Full aggregation's remaining189 explicit-SID invocations all exited0; final aggregate has exactly the inventory ID set. All weighted scores and dimension medians match independently computed A/B inputs (`phase4_aggregation_comparison.json`).
- `render_scorecard.sh` exited0 in0.789s; `render_heatmap.sh` exited0 in238.306s, both with empty stderr. Full stdout artifacts: `scorecard.md`, `heatmap.svg`; producer metadata: `phase4_render_output.json`. These durations are single observations, not performance comparisons.
- Original supplied runtime JSONL and its audit copy have identical SHA-256 (`runtime_evidence_locations.json`). Historical scratch citations resolve to the exact durable copy without rewriting validated scores.
