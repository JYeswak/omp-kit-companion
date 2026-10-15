### Fixed

- `release-train.sh wait-release-idle` counts in-progress and queued release runs with two separate `gh` queries and sums them (`gh` keeps only the last `--status`); the pre-push gate runs `release-train.test.sh` alongside the checker contracts. (ompkit-v66l.2)
