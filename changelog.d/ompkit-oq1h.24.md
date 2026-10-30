### Added
- Refuse new shipped companion references to machine-specific `~/.claude/skills` and `/Users/josh` paths at pre-commit and pre-push; existing baseline references may only shrink.
- Admit baseline-less repositories by comparing against the old Git tree; include the checker, wrapper and baseline in release packages.
