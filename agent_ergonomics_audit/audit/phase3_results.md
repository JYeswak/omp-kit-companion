# Phase 3 replay results

Runner script actual exit: **0**. Corpus rows: **2163**; executed: **2154**; skipped: **9**.

These are observed subprocess results and raw runner heuristics, not independent semantic verification. No source/tests/build/lint/formatter/commit changes were made.

Parent-computed input coverage (`phase3_input_coverage.json`): 2,151 naive entries represent **360 unique argv/env/cwd combinations**, **1,791 duplicate combinations**, and **899 referenced surface IDs**. Raw execution/classification counts below are not counts of independent trials or independent defects. Root-only typo repetitions tagged with scoped surface IDs do not establish scoped flag acceptance or route-specific recovery.

## Raw classification totals

- inferred_and_acted: 16
- skipped: 9
- useful_hint: 2133
- useless_error: 5

## Actual executed process exits

- exit 0: 16
- exit 2: 2138

Prediction-label agreement: 2137/2163; not ground-truth accuracy. Rows with marked target-output truncation: 0; timeout-like statuses (124/137/143, not independently disambiguated): 0.

## Savvy outcomes

- savvy-001: useless_error; exit=2; executed
- savvy-002: useless_error; exit=2; executed
- savvy-003: skipped; exit=None; Not executed: --plan is a path value, not read-only mode; never execute this mutation during audit
- savvy-004: skipped; exit=None; Not executed: Publication command has no advertised read-only/plan mode
- savvy-005: skipped; exit=None; Not executed: Activity recorder has no plan flag
- savvy-006: skipped; exit=None; Not executed: Lesson append is a write even without --commit
- savvy-007: useless_error; exit=2; executed
- savvy-008: skipped; exit=None; Not executed: Deep probe creates fixture/process state and requires separate consent
- savvy-009: useful_hint; exit=2; executed
- savvy-010: skipped; exit=None; Not executed: Private memory read requires explicit consent; no row inspection during audit
- savvy-011: useless_error; exit=2; executed
- savvy-012: skipped; exit=None; Not executed: Read-only default report lacks conventional explicit --plan; audit does not infer safety from absence of --apply

## Concrete semantic caveats

- naive-002 (--josn): generic help-only remediation can be labeled useful_hint; exact intended --json correction is absent.
- naive-007 (--root, intended typo of --robot): parser asks for a PATHS value for a different real flag. A useful_hint label is not recovery of intended --robot. This canonical --root collision appears in 111 generated rows.
- The 16 env typo rows run --version; successful version output can receive inferred_and_acted without detecting the wrong env key.
- savvy-007 supplies an exact supported --scope list in its structured stdout error, and savvy-011 supplies the exact alternatives `Use --db PATH with --repo DIR, or --project DIR alone.` Both receive useless_error because the classifier checks only stderr. Their labels are false negatives for actionable remediation.
- savvy-009 correctly names `Use --json exactly; run omp-kit --help for grammar.` on stderr. This is concrete correction evidence, unlike the generic-help false positive above.
- savvy-001/002 fail first on unknown --role, before unknown-command handling of next. They do not independently exercise semantic next-command suggestion ranking.

See phase3_classification_limitations.md, phase3_generator_notes.md, phase3_runner_constraints.md and phase3_provenance.md. Original runner records are preserved in phase3_runner_raw.jsonl. The canonical corpus retains actual exits for executed rows and null exits plus explicit reasons for skipped rows. Full script outputs/exits are phase3_generator.*, phase3_generator_retry.* and phase3_runner.*.

## Implicit target side effects

Source inspection (src/cli.ts:4459–4461,4492–4497) shows best-effort ccSpool/ccEmit telemetry on ordinary invocations including parse failures and version queries when fleet state is available. Excluding explicit mutation candidates does not prove filesystem-side-effect freedom. This audit did not independently inventory telemetry writes or change target telemetry configuration.

## Post-replay route anchors

The parent supplied verified existing inventory IDs for the twelve preserved savvy rows. stresses_surface_id and explanatory surface_anchor_note were added to both savvy inputs and canonical results after replay, without changing IDs/argv/results. Unknown next commands anchor to verb__help, not an invented next surface. Raw runner output remains unchanged. The provenance savvy hash describes pre-anchor executed inputs; the post-replay partial adds metadata only.
