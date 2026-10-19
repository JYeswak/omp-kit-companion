### Changed

- `scripts/dispatch-check.sh` compares `bv --robot-next` with the top of `br scheduler` over the same claim-admissible set (open, ready, unassigned) instead of `bv --robot-triage`, and still fails closed with `BV_TOP_MISMATCH` (exit 3) on any disagreement.
