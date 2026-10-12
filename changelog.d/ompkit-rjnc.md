### Fixed
- kit-save-guard stays quiet for session paths whose content is already on origin: a local commit that landed upstream under a different sha, or a branch with no upstream configured (falls back to origin/HEAD, then origin/<branch>), no longer re-prompts "Unsaved session-owned work remains" every turn.
- kit-save-guard binds each `candidate <sha> for <paths>` clause to its own sha and paths, so a combined two-repository receipt clears each repository with its own object, and a candidate holding the path's exact current content counts as saved.
