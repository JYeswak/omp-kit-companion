### Fixed

- fleet-guard scratch admission (ompkit-ma3sn) reads the scratch owner through the canonical owner parser, so a write-tool write into an owned scratch dir is admitted whether the owner is the seat form fleet-guard writes (with `agent`, `session`, `bin`) or the JSON form `omp-kit scratch new` writes. Before, only the legacy four-field owner was accepted and every write into a session's own `TMPDIR` was refused as invalid metadata. An owner naming another repository, or an unresolvable one, is still refused.
