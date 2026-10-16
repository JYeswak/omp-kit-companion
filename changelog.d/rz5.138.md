### Breaking Changes
- Add `omp-kit converge` to report, explicitly resolve, and publish shared-main integration without overwriting peer staged or worktree changes (commit e8543ce).
- Change `omp-kit land` to commit reserved paths on shared main before publication, replacing private-index candidates with explicit saved-but-unpublished and uncertain-save outcomes.
- Retire the legacy `align` command; use `converge` to preserve the shared main history.
