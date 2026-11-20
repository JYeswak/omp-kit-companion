### Fixed
- `scripts/full-suite-verdict.sh` resolves `--commit` once to its full object name (an abbreviation, `HEAD` or a branch all work), so every consumer of the commit, including a main-role shard's `git fetch --depth 1 <sha>`, sees the full name. An abbreviated sha broke that fetch on 2026-11-20.
- The suite lease's `SUITE_LEASE_OWNER_UNREADABLE` refusal now says why (the caller's shell reported a virtual `$$`, as the omp bash tool's `sh` and `bash` do) and names the remedy: start the verdict through `/bin/sh` or from a real process.
