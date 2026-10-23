### Fixed

- Test fixtures that seed the OMP source cache now plant the OpenTelemetry runtime entry the cache requires since the incomplete-entry fix, so the runtime and doctor tests exercise the cache instead of failing on a miss (ompkit-kl9p3).
- `omp-kit test --integrations` honours a set `OMP_KIT_TEST_WORK_ROOT`: the work dir goes under that validated caller-owned scratch root, and an unowned or foreign-workspace root fails closed with INTEGRATIONS_UNAVAILABLE before any profile is read, as the xa5s.5 entry already described.
