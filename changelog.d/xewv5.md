### Fixed
- `omp-kit land --exact-parent` can now land a candidate that changes the full-suite judging closure: `scripts/fresh-gate.sh` reads the exact-tree main-role PASS back under the candidate archive as judge root when the candidate's judging identity differs from the land parent's, and the refusal teaches the candidate recipe instead of the base one.
