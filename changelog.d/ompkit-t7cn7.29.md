### Fixed
- Verification now reports independently confirmed missing OMP identity as an environment prerequisite, preserving review status and acceptance while requesting director attention; unrelated assertion failures still become REWORK.
- Actual assertion diagnostics take precedence when the same replay also reports a missing OMP identity; incomplete output cannot be classified as environment-only.
