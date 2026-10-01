# Roadmap

omp-kit is built in public. This file is the plan of record: what is done, what is in review, and what is next. Every pull request that changes the status of an item updates this file in the same change.

**Done** means merged to `main` with CI green, and the acceptance checks re-run by someone other than the author, with output cited. Evidence from a synthetic HOME never closes a real-machine check.

## Why this round exists (reality check, 2026-10-01)

On real operator machines, three things failed that every synthetic-HOME test had passed:

- `test --full` hashed the whole HOME, which always exceeded its bound and changed under unrelated concurrent work.
- `update --apply` therefore could never pass its postcheck.
- State roots created with mode 0755 by the pre-CLI scripts made every receipt command fail with a generic error.

The fixes shipped in #4. This roadmap follows from that finding: prove things on realistic HOMEs, release often, and lean on native OMP features instead of rebuilding them.

## Done

| Item | Where |
|---|---|
| `test --full` watches only operator paths a kit run could write (content and mode); failures name the path | #4 |
| `update --apply` reports failed stages, changed paths and the exact `undo` command on a failed postcheck | #4 |
| State-root permission gate with a named error; `repair --scope state` restores 0700 | #4 |
| `--version`/`-V`; human findings table; no internal tracker ids in user-facing text | #4 |
| CI against the latest OMP every 3 hours, one issue per breaking version (`omp-latest.yml`) | #4 |
| `test --record`, an `omp_drift` finding in status/doctor, and the render-only `examples omp-watch` (launchd/systemd re-test on every OMP update) | #5 |
| Acceptance tests: update postcheck envelope; a rendered-output scan for internal ids | #6 |
| Native-certification receipts name the failing command, stages and scenarios | #7 |
| `health` judges only what a read-only inventory can prove; the rest is listed as `not_judged` and never affects the exit code | #9 |
| Docs for strangers: 60-second README plus a native-OMP guide checked by `bun test tests/cli/docs.test.ts` | #10 |
| Real-HOME journey in CI: 52k-file HOME, edited rules, legacy 0755 state root, a concurrent writer, one JSONL line per step, on macOS and Linux | #12 |
| Latest-OMP CI records first-fire indices per OMP version and reports a default-policy G4 run separately | #13 |
| **Released [v0.2.0](https://github.com/JYeswak/omp-kit-companion/releases/tag/v0.2.0):** 4 natively certified archives, index and receipts; a fresh-HOME install from the published index passes `test --full` (70/70 live, plant caught) | #15 |
| Rules as a native OMP plugin: root plugin manifest, lifecycle e2e (link, fire, disable, uninstall, git install and upgrade); ships in the next release | #14 |
| `health.test.ts` runs in a fresh clone | #16 |

## In review

| Item | PR |
|---|---|
| Rule false fires on quoted text (`kit-settings-mutation`, `kit-test-skip`) | #17 |
| Capability-preserving context: read-only listing-cost report plus `test --capabilities FILE` checked through OMP discovery | #19 |
| Usage-derived skill set and render-only pruned-profile recipe, gated by `test --capabilities` | #22 |

## Next

1. **Release cadence.** Merged user-visible changes ship within 7 days (CONTRIBUTING, Releases); v0.2.1 carries the plugin route.
2. **Intermittent native-certification failures.** Diagnosed: every refusal whose receipt names a cause names the live scenario `test-skip-ts-fire`. The kit's rule blocks the write every time; OMP occasionally ends the run instead of continuing the turn when the match lands late in a short tool call. The upstream report is ready to file; no kit gate is relaxed.
3. **After the plugin route lands in a release:** remove `apply rules`/`apply extensions`, and make `apply policy` write through OMP's native config command.
4. **TTSR policy drift check.** `doctor --scope settings` reads each listed profile's `ttsr.*` with OMP's native config reader and reports drift. The kit writes only `ttsr.*` and its own extension; local-model routing keys belong to the tools that own them.
5. **Service monitoring.** `doctor --scope services` inventories launchd jobs read-only and validates a declared required-jobs file with per-job healthy exit codes and log-line predicates.

## Parked

Gate, pilot and speculative items without a named user are parked: signed provenance, a GitHub Action for rule authors, a foreign-hook importer, automata-based rule proofs, and pairwise settings matrices. Any of them reopens when someone names a concrete need.

## How we work

- Small PRs, each with the evidence it claims: commands, exit codes, CI links, planted negatives.
- No weakened gates, no regenerated goldens, no skips without a stated environmental reason.
- Read `AGENTS.md` before contributing; `NEGATIVE_EVIDENCE.md` records what did not work and why.
