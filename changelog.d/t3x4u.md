### Changed

- The pre-push gate test carries the full-suite judge closure into its fixtures from `scripts/suite-metrics.py`'s `JUDGING_FILES` instead of a hand-kept copy list, so a file added to the closure reaches every fixture with no test edit, and it refuses a closure entry that names a file absent from the repo.
