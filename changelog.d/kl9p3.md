### Fixed

- Test fixtures that seed the OMP source cache now plant the OpenTelemetry runtime entry the cache requires since the incomplete-entry fix, so the runtime and doctor tests exercise the cache instead of failing on a miss (ompkit-kl9p3).
