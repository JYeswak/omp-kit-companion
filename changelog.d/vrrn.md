### Changed
- Releases are `chore: bump version to X.Y.Z` commits that fold `changelog.d/` into `CHANGELOG.md` and set the package.json version, so the installed plugin reports the version it was tagged with; a green commit with no release notes is not released.
- Each GitHub release body is that release's `CHANGELOG.md` section; a release whose section is missing or empty is refused.
- `CHANGELOG.md` follows the upstream oh-my-pi format (`## [Unreleased]`, `## [X.Y.Z] - DATE`, Added/Changed/Fixed buckets).
- README.md resolves the latest release at install time instead of pinning a version, and its command reference lists every command and doctor scope.
- The pre-push doc-drift check accepts a README.md change as documentation for a new command or flag.
