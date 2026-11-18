### Added

- Release operators can use `--caller-commit-next-version` to prepare published-release bookkeeping for their required selective committer. The runner leaves the exact paths and message pending without creating or pushing that commit, preserves the real install outcome, and reuses the caller's published commit on an ordinary `--advance-only` retry.
