### Fixed

- Release certification no longer fails at once on every native target. `omp-kit heavy` now refuses with exit 69 when its disk observer (sbh) is missing, rather than skipping the disk check. The release train's `native-certification` and `real-home-journey` jobs never installed sbh, so the harness gate stopped there (train run 38956579974, `producer_rc=69` on all ship platforms). Both jobs now install the same pinned sbh as the ladders. [selftest]
