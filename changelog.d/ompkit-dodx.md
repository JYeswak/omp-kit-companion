### Fixed

- `omp-kit doctor --scope sessions` shows each session's launch profile (`profile=<name>`, or `profile=<default>`) and names a pane launched without `--profile` in its reason, so a spawn that silently runs the default profile is visible. The code the ompkit-dodx close cited (f3516676de) reaches main with this change.
