### Fixed
- `land`'s published data schema now matches what `src/land.ts` emits: `overall` is `PUSHED`, `REFUSED` or `UNRUN` with a `check` object (`PASS`/`FAIL`/`SKIP`/`UNRUN`); a refusal before any commit carries only those, and a `PUSHED` land must carry `commit`, `candidate_sha`, `pushed_sha`, `owner`, `paths`, `base` and `convergence`.
- Exit code 77 is published as `not_run` in the CLI grammar (`land` with an unavailable repo check; `rch lease` on native refusal).
