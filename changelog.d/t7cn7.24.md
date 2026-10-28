### Fixed

- Native `omp-kit verify` now binds the explicit reviewer identity on every
  durable `br` mutation it performs (intake, REWORK, acceptance ticks,
  reviewer-gate report, close) by passing `--actor <reviewer>` on each
  generated act, instead of letting `br` default to the host user. Previously
  the close reason named the reviewer while the native audit trail recorded
  the ambient user, breaking non-author close attribution.
  Covered by `tests/cli/verify.test.ts` (VERIFYACTOR1 durable-audit cases:
  reviewer on ticks/gate/close and REWORK, same-tracker control untouched,
  author-refusal and dry-run leave state/audit unchanged).
  (ompkit-t7cn7.24)
