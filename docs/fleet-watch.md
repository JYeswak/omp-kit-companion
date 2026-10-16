---
status: current
---

# Fleet Watch

Fleet Watch is an opt-in service. Install it only after creating
`~/.config/omp-kit/fleet-watch.json` and setting `TMUX_TMPDIR` to the value used
by the tmux server.

## Configuration

Each session entry names the worker tmux session, the coordinator session and
pane, the repository used for ready-work lookup, and the worker panes to
monitor. Replace the repo-path placeholder with the dispatcher-local repository path before enabling. Worker panes are tmux pane ids (`%12`, unique on the tmux server) or
session-scoped `window.pane` selectors (`0.1`).

```json
{
  "enabled": true,
  "intervalSeconds": 120,
  "noDecisionChecks": 5,
  "sessions": [
    {
      "session": "feature-workers",
      "coordinatorSession": "orchestrator",
      "coordinatorPane": "%54",
      "repo": "<repo-path-on-this-dispatcher>",
      "workerPanes": ["%1", "%2"],
      "readyCommand": "br ready --json",
      "skipLabels": ["directive"],
      "focusEpics": ["proj-epic1", "proj-epic2"],
      "mission": "ROADMAP.md:9",
      "round": 1,
      "phase": "SORT",
      "pullEnabled": true
    }
  ]
}
```

`readyCommand` defaults to `br ready --json`, must begin with `br ready`,
and runs as argv without a shell. Readiness adds `--no-auto-import` and
`--no-auto-flush`; JSONL-only `--no-db` output is not claim authority.
`skipLabels` adds operator exclusions. Product workers always exclude
`human-gate`, `owner-decision` and `kind:process`, even when `skipLabels`
is absent, including grading and rework selection.
`focusEpics`, `mission` (`file:line`), `round`, `phase` and `pullEnabled`
are optional; a malformed value refuses the config with
`FLEET_WATCH_CONFIG_INVALID: sessions[N].<field>`.
`noDecisionChecks` controls the idle checks before an ordinary no-decision
alert. Capture failures are different: Fleet Watch reports one `NO_DECISION`
with the tmux error and does not infer that the pane is idle or send a nudge.

If an otherwise idle pane shows `Steering · N` and `⌥↑ to edit`, Fleet Watch
submits one queued message by sending `M-Up` then `Enter`, and logs the event.
A busy pane is left untouched.

### Explicit queue flushing

`omp-kit fleet flush-pending --apply --yes` uses a separate doctor path. It only
dequeues one complete, nonempty message over an idle empty composer.
Zero-count, inconsistent, multiple-message and visibly truncated queues do
not authorize a flush. After `M-Up`, the doctor captures the pane again:
`Enter` requires an idle pane, no remaining queue, and a nonempty draft
matching the complete queued message. An ineffective dequeue, capture
failure, changed draft or newly busy pane prevents `Enter`; reports retain
any keys already sent.

These checks do not change Fleet Watch's separate steering branch. Screen
recognition remains heuristic, and capture plus key delivery is not atomic.
If dequeue succeeds but submission is refused, the doctor does not attempt
to roll the draft back. This is not proof of native receiver ownership,
live service safety or the cause of a particular paused goal.

## Pull nudges

An idle worker is nudged once, at the second idle check, with one item to
pull (decision Q20). Fleet Watch chooses it in this order:

1. **Grading queue**: a bead awaiting verification that this worker did not
   author. That is a row in a review status of the tracker's
   `.beads/policy.yaml` (a status reachable from `in_progress` that can reach
   `closed` and is not in the `ready` group: `in_review`, and also `grading` in
   uds), with its assignee as author; or an `open`/`in_progress` bead whose
   last `DONE <bead> <sha> <evidence>` comment has no later `CLOSED`/`REWORK`
   reply or pre-Q22 verdict (`GRADE`, `VERIFIED`, `CONTROLLER VERIFICATION`,
   ...) from another author. A seat whose Agent Mail identity does not resolve
   gets no grading item, because authorship cannot be checked.
2. **Rework queue**: unassigned `rework` rows, or `open` rows labelled
   `rework` when the policy has no `rework` status. While the original
   implementer (the last `DONE`/`PROGRESS`/`OBSOLETE` commenter) holds a
   configured seat, the item waits for that seat; otherwise any worker gets it.
3. **Triage**: the first recommendation from
   `bv --robot-triage --db <repo>/.beads/issues.jsonl`, in recommendation
   order, whose native ready row confirms a claimable leaf under a
   `focusEpics` epic (parent-child edges in
   `.beads/issues.jsonl`, or a dotted child id). With no `focusEpics`, any
   such recommendation qualifies. A higher-ranked pick outside focus is never
   chosen.
4. **Fallback**: the first eligible native ready leaf when ranked candidates
   no longer qualify, not only when bv is unavailable. Focus still applies
   when its DAG is readable. A stale export never authorizes its blocked
   candidate and never globally parks unrelated eligible work. The nudge
   names the fallback reason. Unavailable or malformed bv output and
   `source_authority.claim_safe: false` also use the native fallback.

Grading and rework come before the free-leaf check, so a project with no
ready execution beads still gets grading and rework nudges. Seats idle in the
same tick get different items.

The nudge is one message: mission `file:line`, round and phase, focus epics,
the item, and the close rule (close only a bead you did not author, after
verifying every acceptance item, with the evidence in the close reason).
Workers report to the director pane with `omp-kit send`, using the Q22
reply lines, which come from `WORKER_REPLIES` in `src/fleet-watch.ts`. The
same table parses replies in bead comments:

`CLOSED <bead> <sha> <evidence>`, `REWORK <bead> <gaps>`,
`DONE <bead> <sha> <evidence>`, `PROGRESS <bead> <sha> <remaining>`,
`SPLIT <bead> <child ids>`, `FILED <bead> <parent|no-epic reason>`,
`OBSOLETE <bead> <evidence>`,
`BLOCKED <bead> <dependency|environment|credential|reservation|quota|external|live-action|owner-decision> cmd=<command and output> tried=<approaches and results> fix=<researched unblock and source> next=<item pulled>`,
`QUESTION <bead> <question>`, `SKIP <bead> <reason>`, `NO-WORK <queue counts>`,
`UNHEALTHY <tracker|git|disk|auth|quota|model|tool> <detail>`,
`HANDOFF <bead> <comment ref>`.

**BLOCKED bar (Josh, 2026-10-12).** BLOCKED is a last resort. A BLOCKED line
parses as a reply only with all four fields: `cmd=` the exact failing command
and its output, `tried=` two or more approaches and their results, `fix=` the
researched unblock (command, patch, owner or route) with its source
(`file:line`, doc or skill), and `next=` the item pulled meanwhile. Long output
goes in a bead comment that the line cites. Every nudge states this bar. The
director answers a BLOCKED that misses a field with `REJECTED-BLOCKED <bead>
<missing items>` and sends the worker back to research it; it does not accept,
forward or soften it.

A grading nudge states both outcomes. If every acceptance item is verified,
`br close` the bead with the evidence and send `CLOSED`. If anything is
missing, write one bead comment that names each failed item with its
evidence command and output, and says what success looks like (concrete,
checkable, citing the skill that applies). Then set status `rework` (or
`open` plus label `rework` where the policy forbids that transition),
unassign, and send `REWORK`.

**NO-WORK.** When nothing qualifies (`NO_FREE_LEAF` or `NO_TRIAGE_PICK`), the
director gets one notice per episode and the seat is parked. A parked seat
gets no repeated empty nudge, escalation or no-decision alert. It is
re-checked on every idle tick and woken by any newly eligible grading,
rework or ready item. `WRITE_LATCHED` and `UNKNOWN` still suppress nudges as
before.

### Native refusal evidence

The existing JSONL log and one-shot action output retain `refusals`:
`class`, `bead` (or null for a queue-level condition), `actor`, `next`, and
an optional native comment `citation`. Missing actor evidence is explicitly
`UNKNOWN`, with the coordinator seat named when available; it is not idle
capacity or permission to act.

`PULL_WARNINGS` accompanies a healthy pick when other candidates were
withheld. `NO_FREE_LEAF`, `NO_TRIAGE_PICK`, `WRITE_LATCHED` and `UNKNOWN`
retain their normal meanings and carry the same structured evidence.
Native `br blocked` and batched `br show` reads name the actual blocker and
current owner, rather than trusting exported ownership or merely asking for
a re-export. Typed external endpoints remain dependencies; an unresolved
external owner stays unknown.

Director notice deduplication includes the current refusal fields, so a
changed owner or predicate is not hidden behind an unchanged reason class.
The director receives a bounded pointer to the existing log. A notice is
an observation, **not a delivery receipt**. Refused notice admission sends
nothing; a raised transport is recorded `NOTICE_UNPROVEN` without an
automatic resend, and eligible work continues.

A native `DECISION:` comment from the resolved coordinator can be cited
through a later worker question or closed state. Its reference is not new
authorization: the director still checks its current scope and the canonical
decision record. Generic `DONE`/`PASS` comments are not owner decisions.
Absence of a recognized reference does not prove that no decision exists.
These readers never manufacture a hands-only result from `human-gate` or
login/payment wording alone.

The lifecycle extension prechecks recognized `br update --claim` and
`--status in_progress` calls. Another holder is named in a structured
`CLAIM_REFUSED`; a native lookup error is not treated as unassigned.
An unassigned start requires atomic `--claim`; the same holder may resume
or claim again. `--actor`/`BR_ACTOR` selects the native claim actor;
`--agent-name` is recorded attribution only. Forced or manual
assignment/start combinations are not a substitute for the normal claim.
Closed/tombstoned work is not reopened to obtain supply.

These checks are not a sandbox, a full shell interpreter, a native
incarnation attestation or a permissions grant. `br` still makes the final
atomic award and enforces its policy/dependencies. Source-test fixtures do
not establish installed Tern delivery, service activation or live-fleet
outcomes.

**Parking a round.** Set `phase` to `INSIGHT` (any case) or `pullEnabled` to
`false` and the session's workers get no pull nudge, escalation or
no-decision alert, and no grading nudge. A missing field keeps pulling on.

**One escalation chain (Q23).** The chain runs worker, director (`:0.1`),
chief, Josh. Every worker reply, `UNHEALTHY` and `BLOCKED` owner-decision or
live-action included, goes only to the session's director pane
(`reportCommand` renders each one as `omp-kit send <coordinatorSession>
<coordinatorPane> "<reply>"`). The director escalates. Worker-facing text names
no other route.

Watcher states: BUSY (spinner), IDLE-SILENT (the nudge above), and DEAD (a
failed capture reports `NO_DECISION` to the director first). HUNG and
UNPARSEABLE are tracked in `ompkit-qs0n` and also notify the director first.

Shapes read, observed 2026-10-12 (fixtures in `tests/fixtures/fleet-watch/`):
`bv --robot-triage` v0.25.2 `triage.recommendations[].id` (10 entries) and
`source_authority.claim_safe`; `br list --status S --json` (br 0.7.4)
`{issues, total, limit, offset, has_more}`; `.beads/issues.jsonl`
`dependencies[]` (`type: parent-child`, `issue_id` child, `depends_on_id`
parent) and `comments[]` (`author`, `text`, oldest first);
`am agents resolve-pane --project REPO --pane %ID --json`
(`am.agents.resolve-pane.v1`, `agent_name`).

## Persisted state

Each scheduled invocation loads per-pane idle-check counts, no-decision
throttling, and Steering deduplication from `fleet-watch-state.json` beside
the Fleet Watch JSONL log. The state file is private and atomically replaced.
The file lets separate service processes continue the same idle sequence,
avoid resending the same `Steering · N` message, keep NO-WORK seats parked,
and send each director notice once per episode.

A busy observation or capture failure resets that pane's idle history. Capture
failure remains `UNKNOWN`/`NO_DECISION`; it is not treated as idle and cannot
trigger a nudge. To clear all persisted counters and deduplication state, stop
the Fleet Watch service and remove `fleet-watch-state.json` from the JSONL
log's directory; the next invocation starts with empty state. Do not remove or
edit the state file while Fleet Watch is running.

Malformed or unsafe state is rejected rather than silently reset. If the file
cannot be loaded, stop the service before correcting or removing it.

On each enabled tick, Fleet Watch also checks each configured repository for
the known BusyRecovery `recovery-failed.json` receipt. It recovers only after
the per-flag PID/process-start and tmux-session lease is absent or stale, and
`lsof` confirms no live process has the Beads database open. A live lease,
database holder, or unknown liveness result blocks recovery. Successful and
blocked attempts are recorded as `RECOVERY_PROCEEDED`, `RECOVERY_BLOCKED`,
or `RECOVERY_FAILED` events in the Fleet Watch JSONL log; they do not steer
panes or send a coordinator message. The recovery command runs as
`br doctor migrate-schema recover` from the configured repository.

## Install

Set `TMUX_TMPDIR` to the tmux server's socket directory before rendering or
installing the service. It must be an absolute, existing directory. The value
is copied into the service environment; omitting it refuses installation.

```sh
export TMUX_TMPDIR="/absolute/path/to/tmux-sockets"
KIT="${KIT:-$HOME/.local/opt/omp-kit/bin/omp-kit}"
"$KIT" service install fleet-watch --dry-run
"$KIT" service doctor fleet-watch --json
```

Review the rendered plist, including `TMUX_TMPDIR` and the absolute `PATH`,
then install with `omp-kit service install fleet-watch --apply --yes`.
A missing config or `TMUX_TMPDIR` is a refusal, not a disabled or partially
configured install.
