### Fixed
- `infra undo --apply` is a boolean flag: it no longer swallows the next flag as its value, so a request without `--yes` reaches the safe refusal. (commit 07df535)
