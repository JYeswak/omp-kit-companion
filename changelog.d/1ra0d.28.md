### Fixed

- Commit preflight now judges the same candidate outside Git's index lock; commits verify the prepared tree and refuse changed paths or parents instead of blocking other writers for the gate run. `save` and `land` prepare automatically; direct commits use `scripts/commit-preflight.sh --message FILE --files PATH...` first.
