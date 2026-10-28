### Fixed

- `omp-kit verify` no longer throws on dotted bead ids before exporting the
  candidate (ompkit-t7cn7.20). The scratch label is the constant `verify`
  while the exact bead identity still travels in the allocation metadata, so
  `verify-ompkit-t7cn7.18`-style derived labels cannot reach the kitlib tmp
  label grammar. The label grammar itself is unchanged. Covered by
  `tests/cli/verify.test.ts` (19 tests: a dotted bead id proceeds past
  scratch allocation through the real `verifyBead` path with per-box
  replays; all prior planted negatives unchanged).
