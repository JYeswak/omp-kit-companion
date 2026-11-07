### Fixed
- ompkit-1ra0d.42 (WORKTREEKEY1): a `git commit` in a linked worktree now reads the seat's Agent Mail reservations under the canonical repo key (the parent of git's common dir) instead of the worktree path, so paths reserved for a builder worktree are no longer refused as PATH_UNRESERVED; unreserved paths still are.
