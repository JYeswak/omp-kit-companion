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

## In review

| Item | PR |
|---|---|
| Acceptance tests: update postcheck envelope; a rendered-output scan for internal ids | #6 |
| Native-certification receipts name the failing command, stages and scenarios | #7 |
| `health` judges only what a read-only inventory can prove; the rest is listed as `not_judged` and never affects the exit code | #9 |

## Next

1. **Real-HOME journey in CI.** One script runs the README path against a realistic HOME (50k files, edited rules, legacy 0755 state root, a concurrent writer) on macOS and Linux, logging one JSONL line per step. This would have caught every real-machine bug above. Required before the next release.
2. **Release v0.2.0**, then a regular cadence. v0.1.x binaries cannot update on a real HOME; reinstall with the installer.
3. **Diagnose intermittent native-certification failures.** One target in a run sometimes refuses. #7 makes the cause visible; the fix follows from the receipts.
4. **Rules as a native OMP plugin.** OMP plugins ship `rules/` natively, so the kit's own copy step can go. In a live proof with the rules delivered only through a linked plugin, 69 of 70 scenarios passed and the planted negative was caught. The one failure is the kit's own `apply policy` assuming `~/.agents/rules`. After the switch, `apply rules`/`apply extensions` are removed and `apply policy` writes through OMP's native config command.
5. **TTSR policy drift check.** `doctor --scope settings` reads each listed profile's `ttsr.*` with OMP's native config reader and reports drift. The kit writes only `ttsr.*` and its own extension; local-model routing keys belong to the tools that own them.
6. **Docs for strangers.** A README a new user can follow in 60 seconds, plus a native-OMP guide (`omp ttsr list/test/scan`, `omp plugin`) that CI checks against the latest OMP.

## Parked

Gate, pilot and speculative items without a named user are parked: signed provenance, a GitHub Action for rule authors, a foreign-hook importer, automata-based rule proofs, and pairwise settings matrices. Any of them reopens when someone names a concrete need.

## How we work

- Small PRs, each with the evidence it claims: commands, exit codes, CI links, planted negatives.
- No weakened gates, no regenerated goldens, no skips without a stated environmental reason.
- Read `AGENTS.md` before contributing; `NEGATIVE_EVIDENCE.md` records what did not work and why.
