### Fixed
- Owned-scratch reaper (SCRATCHREAP2): an expired quarantine tree with a macOS user-immutable flag (`uchg`/`schg`) on a nested file or directory is a named `user-immutable` refusal, not a failed deletion; other delete failures remain failures.
