### Fixed

- The live-scenario mock model launches under a real `bun` when one resolves (`BUN_BE_BUN=1`), instead of `process.execPath`, which is the compiled binary in a release and answers `UNKNOWN_COMMAND` instead of serving. (ompkit-ssfx)
