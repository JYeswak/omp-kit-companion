### Fixed

- `omp-kit planning score` derives plan-to-code latency from the configured `[plan].first_commit` without requiring a synthetic draft marker. The metric reports verified Git commit/timestamp provenance and explicit UNKNOWN reasons for invalid, ambiguous, or unavailable evidence; absent anchors retain tagged-draft behavior.
