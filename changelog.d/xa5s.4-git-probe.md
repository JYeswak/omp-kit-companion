### Fixed

- `omp-kit test` no longer reports `BUNDLED_RUNTIME_UNAVAILABLE` on a Mac whose first Git call is slow. The admission proof gives each Git call 2 s, and on macOS the first `/usr/bin/git` call after a boot can take longer while xcrun finds the toolchain. The fast test now runs `git --version` once, with a 60 s limit, before the proof starts. When Git is missing it reports the new blocker `GIT_UNAVAILABLE` with an install remedy (commit feced13).
