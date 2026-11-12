### Added

- The kit-upgrade-notice now appends the installed release's `CHANGELOG.md` bullets newer than the seat's release (`What changed since <loaded>:`, newest section first, capped at about 40 lines / 6 KB with an `and N more; full notes: <path>` line), so a restarting agent knows which behaviours changed under it. `CHANGELOG.md` now ships inside every release tree.
- Synthetic update candidates in the test fixtures now include CHANGELOG.md, matching the packaged tree.
