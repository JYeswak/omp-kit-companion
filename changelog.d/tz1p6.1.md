### Fixed
- Recover an interrupted tag-only release with `--resume-from-draft --version X.Y.Z --source <expected-sha>`: rebuild through every release gate, verify the immutable tag before draft creation, and never re-tag.
