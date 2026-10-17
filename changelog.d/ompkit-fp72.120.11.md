### Fixed

- Align substitution live scenarios with the pre-execution tripwire rule: the unsafe double-quoted substitution must not create its action marker; the single-quoted near miss still executes. Preserve the production matcher and coverage checks.
