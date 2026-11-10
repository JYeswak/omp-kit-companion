---
status: current
---

# Fleet routing configuration

Fleet Watch's scheduled service and seat nudging are retired. Native goal
continuation and Agent Mail wakes handle continuation; registering a project
does not start a monitor. `service install fleet-watch` is no longer supported.

## Configuration retained for admission

`~/.config/omp-kit/fleet-watch.json` (or `OMP_KIT_FLEET_WATCH_CONFIG`) remains
operator data. Do not remove it: bead-creation admission resolves each repo's
`coordinatorSession` and `coordinatorPane` from `sessions[]`.

```json
{
  "sessions": [
    {
      "session": "feature-workers",
      "coordinatorSession": "feature-workers",
      "coordinatorPane": "tern:123",
      "repo": "<absolute-repository-path>",
      "workerPanes": ["tern:124"]
    }
  ]
}
```

`project add` keeps writing this entry and the created pane ids, alongside the
roster and repo opt-in, and proves initial goal delivery. It does not install a
watcher. Other consumers still use this file's `skillMine`, `ccCompress`,
`gateRationalize` and `respawnSeat` settings; these are unchanged. Existing
milestone, pause, mission and registered-tracker metadata remains readable.
There is no pull/preassignment or queued-steering submission path in Fleet Watch.

## Seat wake health

`omp-kit project status SESSION --json` reports the last wake outcome and its
`ts` timestamp for each resolved seat agent name, under `seats[].wake`.
The ledger is `mail-wake.jsonl` in the resolved kit state root
(`$XDG_STATE_HOME/omp-kit`, default `~/.local/state/omp-kit`). A seat with no
record has `outcome: "no wake recorded"` and `at: null`. A wake receipt is not
proof that a seat completed work; live seat identity, goal and activity remain
separate status fields.

## Retained, unscheduled maintenance code

The internal `runFleetWatchOnce` entrypoint remains for recovery/audit callers
and their tests, not as an installable job. It retains busy-tracker recovery,
quarantine retention, git index-lock reaping and stranded-work audit routing.
These functions are not a replacement polling service and are not scheduled by
`service install`. Recovery and reaping keep their existing liveness, custody,
admission and receipt gates. Stranded audit routing remains director-facing;
idle workers receive no messages or key submissions.
