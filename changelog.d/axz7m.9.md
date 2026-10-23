### Fixed
- Reuse immutable Git commit facts within each stale-worktree gate invocation instead of rereading them for every removed line, preserving line-specific stale and foreign-bead decisions.
- Join removed sites to blame once in original site order, refusing join I/O failures instead of silently skipping checks.
- Refuse failed or incomplete Git observations instead of treating them as clean history. Proving an unborn branch uses Git 2.46+ `show-ref --exists`; an unavailable lookup refuses rather than guessing.
