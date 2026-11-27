### Fixed
- The stale-worktree guard permits a line to move to deeper indentation within the same staged hunk. It still refuses cross-hunk and cross-file moves, restored landed pre-images, and reuse of one addition for multiple removals.
