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

## In review

| Item | PR |
|---|---|
| Release v0.2.0 (changelog cut, install pin, release procedure in CONTRIBUTING) | this PR |
| Rules as a native OMP plugin: root plugin manifest, lifecycle e2e (link, fire, disable, uninstall, git install and upgrade) | #14 |

## Next

1. **Release cadence.** Merged user-visible changes ship within 7 days (CONTRIBUTING, Releases).
2. **Intermittent native-certification failures.** Diagnosed: both refusals with receipts name the live scenario `test-skip-ts-fire`. The kit's rule blocks the write every time; OMP occasionally ends the run instead of continuing the turn when the match lands late in a short tool call. The upstream report is ready to file; no kit gate is relaxed.
3. **After the plugin route lands:** remove `apply rules`/`apply extensions`, and make `apply policy` write through OMP's native config command.
4. **TTSR policy drift check.** `doctor --scope settings` reads each listed profile's `ttsr.*` with OMP's native config reader and reports drift. The kit writes only `ttsr.*` and its own extension; local-model routing keys belong to the tools that own them.
5. **Rule false fires on quoted text.** `kit-settings-mutation` and `kit-test-skip` interrupt commands and files that merely quote their trigger text; add those shapes as quiet cases and tighten the conditions without losing a fire case.
6. **Capability-preserving context.** A read-only report of what each profile lists into the prompt (skills, context files, rules, tool descriptors), measured with OMP's own loaders, plus `test --capabilities FILE`, which checks that a declared set of required skills, tools, rules and LSP still resolves after a profile is pruned with OMP's native skill settings. Benchmarks of pruned profiles belong to dedicated benchmark tooling; the kit supplies the capability check they gate on.

## Parked

Gate, pilot and speculative items without a named user are parked: signed provenance, a GitHub Action for rule authors, a foreign-hook importer, automata-based rule proofs, and pairwise settings matrices. Any of them reopens when someone names a concrete need.

## How we work

- Small PRs, each with the evidence it claims: commands, exit codes, CI links, planted negatives.
- No weakened gates, no regenerated goldens, no skips without a stated environmental reason.
- Read `AGENTS.md` before contributing; `NEGATIVE_EVIDENCE.md` records what did not work and why.
