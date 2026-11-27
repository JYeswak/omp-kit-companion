### Fixed
- `omp-kit verify` accepts a published export whose top level is not `scripts/` or `src/` (a `lib/` and `tests/` tree verifies). A failed or empty archive is still refused, and the refusal names the cause instead of `export failed rc 0:` with nothing after it.
