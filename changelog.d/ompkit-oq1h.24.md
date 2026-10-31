### Added
- Refuse new shipped companion references to machine-specific `~/.claude/skills` and `/Users/josh` paths at pre-commit and pre-push; existing baseline references may only shrink.
- Admit repositories without a baseline: compare committed history against the old Git tree and unborn repositories against an empty source tree; include the checker, wrapper and baseline in release packages.
