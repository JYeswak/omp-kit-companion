### Fixed

- `omp-kit land` finds the release-qualification starter in the kit release when the working tree it runs from lags main and lacks it, and the release now ships `scripts/release-verdict-start.py`, so a land publishes with a scheduled main-role verdict even from the lagging canonical tree (its local main had no merge base with origin/main on 2026-11-23).
