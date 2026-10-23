### Fixed
- Reuse immutable Git commit facts within each stale-worktree gate invocation instead of rereading them for every removed line, preserving line-specific stale and foreign-bead decisions.
- Join removed sites to blame once in original site order, refusing join I/O failures instead of silently skipping checks.
