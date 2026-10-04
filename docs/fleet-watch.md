# Fleet Watch

Fleet Watch is an opt-in service. Install it only after creating
`~/.config/omp-kit/fleet-watch.json` and setting `TMUX_TMPDIR` to the value used
by the tmux server.

## Configuration

Each session entry names the worker tmux session, the coordinator session and
pane, the repository used for ready-work lookup, and the worker panes to
monitor. Pane IDs are scoped to their tmux session.

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
      "repo": "/Users/me/Developer/project",
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
