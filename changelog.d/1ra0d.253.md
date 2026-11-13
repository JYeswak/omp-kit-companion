### Fixed

- `omp-kit planning score` scores only the configured plan mission when `.omp/plan.toml` names it; commit-tag discovery is the fallback for repos without one, so stray tags never become phantom scored missions.
