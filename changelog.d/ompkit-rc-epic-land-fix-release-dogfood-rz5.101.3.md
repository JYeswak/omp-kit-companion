### Fixed
- Stale Git index-lock handling is dry-run-only: only `dryRun: true` reports `WOULD_MOVE`; omitted, false, null, or other values return `APPLY_REFUSED` before filesystem access. `scratch index-lock --apply` is always refused because the pathname check cannot prove writer quiescence.
