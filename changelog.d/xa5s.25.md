### Fixed

- Fleet guard refuses unscoped `git commit --amend` before any refs/index/worktree change in all wrapper forms (`-C`, `-c`, env assignments, compound commands); explicit `--only` is not history-rewrite authority. Ordinary scoped commits, `--no-amend`, quoted prose, and `--` paths still pass. (ompkit-xa5s.25)
