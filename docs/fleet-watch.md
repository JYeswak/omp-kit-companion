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
monitor. Replace the repo-path placeholder with the dispatcher-local repository path before enabling. Pane IDs are scoped to their tmux session.

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
      "skipLabels": ["directive"]
    }
  ]
}
```

`readyCommand` defaults to `br ready --json`; `skipLabels` is optional.
`noDecisionChecks` controls the idle checks before an ordinary no-decision
alert. Capture failures are different: Fleet Watch reports one `NO_DECISION`
with the tmux error and does not infer that the pane is idle or send a nudge.

If an otherwise idle pane shows `Steering · N` and `⌥↑ to edit`, Fleet Watch
submits one queued message by sending `M-Up` then `Enter`, and logs the event.
A busy pane is left untouched.

## Persisted state

Each scheduled invocation loads per-pane idle-check counts, no-decision
throttling, and Steering deduplication from `fleet-watch-state.json` beside
the Fleet Watch JSONL log. The state file is private and atomically replaced.
The file lets separate service processes continue the same idle sequence and
avoid resending the same `Steering · N` message.

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
