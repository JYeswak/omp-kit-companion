# Troubleshooting

| Error | Meaning | Fix |
|---|---|---|
| `OMP_UNAVAILABLE` | No supported `omp` launcher on PATH | Install OMP your usual way and put `omp` on PATH; omp-kit will not install it |
| `REQUIRED_FINDING_FAILED: Release rule inventory cannot be verified` | `doctor --scope kit` ran from a source tree or a damaged install | Use an intact, verified release from the installer |
| `PENDING_RECOVERY` / `PARTIAL_UNDO` | A receipt or inverse mutation needs recovery; nothing was rolled back or deleted | Run `omp-kit audit --json`, check the postimages, then `omp-kit update --reconcile RECEIPT --yes` for an update or `omp-kit undo RECEIPT --yes` |
| `INVALID_STATE_ROOT` | `XDG_STATE_HOME` is relative or not canonical | Set an absolute `XDG_STATE_HOME` or unset it; `omp-kit repair --scope state` fixes only the mode |
| `KIT_UPDATE_JOB_CONFIG` | kit-update has neither a static tuple nor poll settings | Set `OMP_KIT_UPDATE_POLL=github` with `OMP_KIT_UPDATE_REPO=owner/repo`, or the four static inputs, or leave the job off |
| `BUNDLED_RUNTIME_UNAVAILABLE` | The release is missing `scripts/ttsr-harness.ts` or its resources | Reinstall an intact release and rerun |
| `REGEX_BUDGET_REPORT_INVALID` | `--regex-budget-report` has no valid `JSON_REPORT=` line | Capture the full `scripts/regex-budget.ts` output, even on nonzero exit |
| `FLEET_WATCH_CONFIG_MISSING` / `FLEET_WATCH_TMUX_TMPDIR_MISSING` | Fleet Watch has no config or no tmux socket directory | Create `~/.config/omp-kit/fleet-watch.json` and export `TMUX_TMPDIR` before installing the service |
| `installer: refused: archive SHA-256 mismatch or size limit` | The downloaded archive does not match the index | Re-download; do not bypass the check |
| `BEAD_REQUIRED` from `send` | A work dispatch cites no bead id | Add the bead id or pass `--no-bead-reason TEXT` |
