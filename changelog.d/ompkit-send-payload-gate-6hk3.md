### Fixed

- `proveSend` refuses a destructive payload addressed to a shell pane at send time (`ADMISSION_REFUSED` naming `send-payload-tmux-kill-server`, `send-payload-pattern-kill` or `send-payload-rmrf-critical`): the target pane's `pane_current_command` is checked only when the cheap local payload match hits, so benign sends cost zero extra tmux calls. The same text to an agent pane is prose and still passes. (ompkit-send-payload-gate-6hk3)
