### Added

- `omp-kit land` runs repository `commit-msg` hooks and the unchanged, base-registered `.omp/push-check` against the exact publication candidate before no-force publication; it reports `PUSHED`, `REFUSED`, or `UNRUN` distinctly.
- The push-check contract test expects the realpath of the shebang interpreter that `omp-kit land` records, so it passes on usr-merged Linux runners where `/bin/bash` resolves to `/usr/bin/bash`.
