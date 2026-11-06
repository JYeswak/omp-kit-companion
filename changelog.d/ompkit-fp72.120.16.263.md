### Fixed
- Local release prepare and next-version commits declare the prior writers of rewritten package and README version lines, so stale-worktree admits intended version bumps without authorizing unrelated writers. Dirty post-cut changelog fragments stay untouched; dirty metadata and folded fragments still refuse before any write.
