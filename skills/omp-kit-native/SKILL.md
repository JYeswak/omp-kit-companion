---
name: omp-kit-native
description: Maps fleet situations to the omp-kit native verb that handles them (waiting, verification, publishing, CI state, scratch, goal delivery, pane sends, doctor, mission anchor, plan conversion, receipts) and files a bead for any missing verb. Use when a worker or director is about to sleep, poll gh, push, delete scratch, resend a goal, hash evidence by hand, or work around a gap.
---

# omp-kit native verbs

Before hand-rolling a fleet step, use the native verb for it. Each row below names its
replacement and the rate measured over 24 h on four live seats (2026-10-19, 59 seat-hours:
`~/Developer/omp-kit/docs/evidence/prompt-native-20261019/table.md`). The full verb inventory is
`omp-kit capabilities --json`; check a verb's flags with `--help` before you cite it.

## Situation → native verb

| Situation | Native verb | Replaces (measured) |
|---|---|---|
| Waiting: nothing claimable or verifiable | `python3 ~/Developer/omp-kit/scripts/idle_wait.py --repo . --agent <name> --max 600` (directors add `--role director`). It wakes when the tracker or mail changes; never sleep blind | idle_wait without --max, each a 30 s wake (TEXT-LOOP and goal stall, ompkit-xa5s.31): 5.65/seat-h; blind sleep of 30 s or more: 0.03/seat-h |
| Verification of another agent's in_review bead | `task` background agent per J-2026-10-18-12: one that did not write the change replays the original acceptance with literal inputs on an exact-commit `git archive` export under owned scratch, with a read-only tracker. Close or REWORK on its exit-0 evidence the same turn | in_review left waiting for a peer: 0 observed background verifiers on the cfsios worker in 8.0 seat-h (fleet 1.16/seat-h) |
| Publishing a verified commit | `python3 ~/Developer/omp-kit/scripts/git_converge.py --repo . --push`, or `omp-kit land` for reserved paths. CONVERGE_BUSY means another publisher holds the lock: do other work, then retry once. Never loop on it | git push outside git_converge or land: 2.38/seat-h |
| CI state | `omp-kit ci status --json`. UNAVAILABLE means a missing or stale cache: report UNKNOWN and move on | gh run watch, view or list polling: 0.93/seat-h, against 0.04/seat-h for ci status |
| Scratch you finished | `omp-kit scratch release <dir> --bin throwaway` (evidence and promote need `--ref`); find your rows with `omp-kit scratch plan --json`. There is no `scratch mine` verb yet: ompkit-774u.15 | rm of scratch: 0 observed (DCG blocks it); release ran 0.05/seat-h while finished scratch waited for the reaper |
| Goal delivery to a seat | `python3 ~/.claude/skills/omp-kit-orchestration/scripts/arm_seat.py --session <s> --block <b> --version <N> --apply`. On any error (J-2026-10-18-25): send `/goal drop`, confirm, verify a goal-less mode_change in the seat's session file, then set the new goal and verify its id. Never stack a goal or resend blind | direct /goal pushes to panes: 0.02/seat-h (1 observed), against 0.42/seat-h for arm_seat |
| Sends to a pane | `omp-kit send <session> <pane> <message> --json`. It proves landing and defers a busy pane | raw tmux send-keys or ntm send: 0 observed; omp-kit send 0.25/seat-h |
| Doctor checks | `omp-kit doctor --scope <component> --json` (beads, reservations, identity, flywheel, fleet, work and more; see `--help`) | unscoped doctor: 0 observed; an unscoped run takes 35-42 s |
| Mission anchor | `omp-kit mission anchor --project . --json` | hand reads of mission.toml or MISSION.md: 0.03/seat-h (2 observed) |
| Plan to beads | `omp-kit planning convert --plan <file> --mission <m> --dry-run --db <dir>`, then `--apply --tracker-root . --actor <name>` | 3 or more br create in one command: 0.02/seat-h (1 observed) |
| Receipts for derived evidence | `python3 ~/Developer/omp-kit/scripts/receipt.py sign --producer <p> --operation <op> --result-sha256 <sha> --out <file>`; check with `receipt.py verify <file>` | evidence hashed by hand outside receipt.py: 0.67/seat-h |
| Seat state (directors) | `python3 ~/.claude/skills/omp-kit-orchestration/scripts/fleet_seat_audit.py --tabs <session> --json` | tmux capture-pane scrapes: 0 observed; audit 1.01/seat-h |
| Missing native verb | `omp-kit capabilities --json` first; if no verb fits, apply the gap rule below | gap lines with no bead within 10 lines: 2.88/seat-h (text 2.14, mail 0.74) |

## Gap rule: every gap becomes a bead the same turn

A gap is anything you hit that blocks or degrades the work: a missing verb, a refusal with no
remedy, a broken or missing check. Reporting it in chat or mail is not filing it.

1. `br search "<words>"` in the repo that owns the fix: `~/Developer/omp-kit` for kit verbs and
   fleet protocol, the project repo for product defects. If a bead exists, comment the new
   occurrence on it with your evidence.
2. Otherwise `br create --parent <epic> --acceptance "<planted negative>" --actor <name>`: the
   acceptance names an input that fails before the fix and passes after. Add the blocks edge with
   `br dep add <blocked-bead> <new-bead>`.
3. For a kit gap, also send your chief one Agent Mail line: `GAP <bead-id> <missing verb>: <misuse it forces>`.
4. Never hand-roll the protocol in a project repo (a local wait loop, publish script or CI poller).
   Use the nearest native verb, carry on with other work, and let the kit bead close the gap.

## When NOT to use

- OMP harness features (TTSR rules, plugins, settings): `/skill:omp-native`.
- Installing or updating the kit rule pack: `/skill:omp-kit`.
- Tracker mechanics beyond these rows: `/skill:beads-br`.

## Check

`python3 scripts/check_rows.py` confirms every row's verb is runnable in the installed kit, that
every flag it cites appears in that verb's `--help`, that every row cites a measured rate, and that
no required situation is missing. `--selftest` plants a row naming `omp-kit scratch mine`, an
unknown flag, a row with no measurement and a missing situation; each must fail.
