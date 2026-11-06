### Fixed
- Task model checks use live host session settings with bounded standalone Bun discovery when a compiled host cannot import its source, preserving runtime model precedence and failing closed with the cause when settings are unreadable.
