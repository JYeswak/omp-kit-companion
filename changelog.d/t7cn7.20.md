### Fixed

- `omp-kit verify` no longer throws on dotted bead ids before exporting the
  candidate (ompkit-t7cn7.20). The scratch label is the constant `verify`
  while the exact bead identity still travels in the allocation metadata, so
  `verify-ompkit-t7cn7.18`-style derived labels cannot reach the kitlib tmp
  label grammar. The label grammar itself is unchanged. Covered by
  `tests/cli/verify.test.ts` (20 tests: a dotted bead id proceeds past
  scratch allocation through the real `verifyBead` path with per-box
  replays; an unresolvable bead names the unmet tracker prerequisite
  with zero writes; all prior planted negatives unchanged).
- A missing tracker binding now names its unmet prerequisite instead of a
  bare exit code. When `br show` cannot resolve the bead, the refusal
  names the sought bead and the bound tracker's own identity (read from
  `br where`, never hardcoded), so a wrong or empty tracker reads as
  the unmet prerequisite rather than `exit N with no message`.
