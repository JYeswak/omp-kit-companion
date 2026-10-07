- scratch service test pins quiet load; heaviest multi-spawn test gets an explicit 30s timeout.
- fast-test and integrations suites use a suite-owned TMPDIR they remove, with a planted check that a fixture cycle leaves session-omp-test unchanged in size.
- Flywheel close-verdict and lesson metrics now read br comment `text` with `body` fallback; the verdict proxy notes that it counts a VERDICT from any author.

<!-- release coverage: (commit d37ffb1) -->
