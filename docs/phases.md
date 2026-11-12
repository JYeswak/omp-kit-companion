---
status: current
---

# Lifecycle phase commands

`docs/lifecycle.md` maps each phase from an idea to a happy, paying user, and
`docs/lifecycle.json` is the checked source for that map. This page covers the
five phases whose commands have no page of their own: discover, verify, launch,
measure-value and learn. `docs/land.md` covers build,
`docs/release-procedure.md` covers release, and `docs/service-contract.md`
covers operate.

## Discover: record the need

`omp-kit intake --from joshua --text TEXT --seat SEAT [--kind rule|work]` records
one request word for word and resolves who acts on it.

- `--kind work` (the default) searches the tracker for a matching bead and
  creates one if none exists. It then prints `DO` when the receiving seat should
  do the work itself, or `ROUTE <bead> -> <seat>` when the seat's role routes it
  elsewhere.
- `--kind rule` records a decisions row instead of a bead.
- `--deliver` sends a `ROUTE` through the bead assignee, Agent Mail and Tern, and
  proves that the delivery landed.

The exit criterion is that the need exists as checkable text: a bead with a
what, a why and acceptance boxes that a command can replay.

## Verify: prove it by replay, not by author word

`omp-kit verify BEAD --export SHA --lesson TEXT` is the one close verb, and it is
run by a seat that did not write the change:

1. Exports the exact commit into owned scratch with `git archive`.
2. Replays every acceptance box's command against the export and judges each
   box by its named expected outcome (`-> rc 0`, `-> N pass 0 fail`,
   `-> prints TEXT`).
3. Ticks the passing boxes and records the reviewer gate under the verifier's
   identity.
4. Closes the bead with the command log and a lesson. A failing box reopens the
   bead as REWORK, naming the box.

Unticked `[live]` and `[after]` boxes move word for word into an open
`LIVEREADBACK` child. Once the change is released and installed, run
`omp-kit verify CHILD --live-readback` (or `--live-readback --all`) to read
those boxes back on the installed kit. `--dry-run` replays without touching the
tracker.

Before handing a change over, the author runs `omp-kit preflight commit`, which
judges the staged index with the pre-commit and commit-msg hook members, and in
this repository also `sh scripts/commit-preflight.sh --files <paths> --tests
affected`, which runs the affected tests the commit gate will run.

## Launch: pin readiness before users arrive

`omp-kit milestone launch SESSION --set KEY=VALUE ...` stores launch pins on
the milestone record. It reports `READY` only when all four pins resolve:

| Pin | What it names |
|---|---|
| `asset_freeze` | the bead that froze shipped assets |
| `runbook` | the operator runbook path |
| `value_metric` | the user-value metric the launch is judged by |
| `rollback` | how to return to the previous release |

## Measure value: is the product doing its job?

`omp-kit value [--project PATH]` measures one project's declared user-value
metric against its target. The project declares `.omp/value.json` as
`{"name": str, "command": [argv...], "target": number}`: the command runs as an
argv list, never through a shell, with cwd set to the project and a 30 s
deadline, and its stdout must parse as one finite number.

- exit 0 `MET`: the value meets its target.
- exit 1 `BELOW`: the value missed its target.
- exit 2 `UNDECLARED`: no (or invalid) `.omp/value.json`; the remediation
  names the file and its shape.
- exit 3 `UNKNOWN`: the command failed, timed out, or printed no number.

`--json` carries name, value, target, verdict and command argv. The
measure-value row of `docs/lifecycle.json` names this verb, and
`tests/cli/value.test.ts` replays every exit class against fixture projects.

## Learn: turn incidents into lessons, then into fewer gates

- `omp-kit lessons add --class CLASS --what TEXT --evidence TEXT` appends one
  evidence-backed lesson. `--kind CORRECTION --corrects ID` retires an earlier
  record without rewriting history.
- `omp-kit mine --since DATE --until DATE [--project P|--all]` reads
  transcripts, the tracker, git and hook history for a UTC window, and ranks
  cited enforcement candidates. It is read-only.

A lesson goes down the ladder before it becomes a gate. Design the step out
with a verb. Failing that, let a hook auto-complete what the system already
knows. Failing that, teach it in a skill. A reminder rule comes next, and a
refusing gate comes last, only for irreversible hazards.
