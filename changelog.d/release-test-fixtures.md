### Changed
- Run live scenarios in a bounded pool of private HOMEs and model configurations, preserving ordered verdicts and parent-owned case counts. The default is `min(8, max(1, online CPUs / 4))`; `OMP_KIT_E2E_JOBS` selects an explicit width.
- Reuse only read-only native bindings keyed by the selected OMP version and executable digest, plus private copies of immutable Bun transpilation output; configs, credentials, extension databases and model files remain private to each scenario.
- Schedule the updater's N+2, compiled activation and relink-refusal live journeys, and the installed-package live ladder, as separate CI-only files without removing their assertions or live checks.
