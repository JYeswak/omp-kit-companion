### Fixed

- A `br update <id> --claim` on a bead carrying an unresolved `needs-director` label is now refused before the real tracker mutates. The `br` shim relays the native claim-preflight verdict (`BR_SHIM_NEEDS_DIRECTOR`) and adds no second policy, names, or roster; an inconclusive probe passes through with a warning, and an explicit `--db` redirection skips the probe. (ompkit-izpwd.1)
