### Fixed

- `omp-kit doctor` no longer reads a slow rch as a missing one: a `rch --json daemon status` probe killed at its deadline is reported as `RCH_PROBE_TIMEOUT` (UNVERIFIED) and the row stays in the unscoped inventory, and that probe now gets the 15 s its sibling rch probes have instead of 5 s.
