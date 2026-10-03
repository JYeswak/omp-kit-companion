# Session freshness doctor

`omp-kit doctor --scope sessions` now inventories live OMP processes and their tmux panes, compares process start times with installed OMP, kit plugin, and `~/.agents/AGENTS.md` mtimes, and reports CURRENT, STALE, or UNVERIFIED with named stale markers.
