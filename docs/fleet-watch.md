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

`readyCommand` defaults to `br ready --json` and is run (as `br` argv, no
shell) to list the session's ready rows; `skipLabels` is optional. `focusEpics`,
`mission` (`file:line`), `round`, `phase` and `pullEnabled` are optional; a
malformed value refuses the config with `FLEET_WATCH_CONFIG_INVALID:
sessions[N].<field>`.
`noDecisionChecks` controls the idle checks before an ordinary no-decision
alert. Capture failures are different: Fleet Watch reports one `NO_DECISION`
with the tmux error and does not infer that the pane is idle or send a nudge.

If an otherwise idle pane shows `Steering · N` and `⌥↑ to edit`, Fleet Watch
submits one queued message by sending `M-Up` then `Enter`, and logs the event.
A busy pane is left untouched.

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
3. **Triage**: the first `bv --robot-triage` recommendation, in
   recommendations order, that the ready rows confirm as a claimable leaf and
   that sits under a `focusEpics` epic (parent-child edges in
   `.beads/issues.jsonl`, or a dotted child id). With no `focusEpics`, any
   such recommendation qualifies. A higher-ranked pick outside focus is never
   chosen.
4. **Fallback**: only when bv is unusable (it fails or times out, prints
   non-JSON, has no `triage.recommendations`, or reports
   `source_authority.claim_safe: false`) or the DAG cannot be read, the first
   claimable leaf in the ready rows, still under focus when the DAG is
   readable. The nudge names the reason.

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
`BLOCKED <bead> <dependency|environment|credential|reservation|quota|external|live-action|owner-decision> <route>`,
`QUESTION <bead> <question>`, `SKIP <bead> <reason>`, `NO-WORK <queue counts>`,
`UNHEALTHY <tracker|git|disk|auth|quota|model|tool> <detail>`,
`HANDOFF <bead> <comment ref>`.

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

**Parking a round.** Set `phase` to `INSIGHT` (any case) or `pullEnabled` to
`false` and the session's workers get no pull nudge, escalation or
no-decision alert, and no grading nudge. A missing field keeps pulling on.

Watcher states: BUSY (spinner), IDLE-SILENT (the nudge above), and DEAD (a
failed capture reports `NO_DECISION` to the director). HUNG and UNPARSEABLE
are tracked in `ompkit-qs0n`.

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
