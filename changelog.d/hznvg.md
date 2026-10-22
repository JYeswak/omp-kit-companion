### Fixed

- The ownership registry now lists `extensions/kit-composer-state.ts`, the writer of `~/.local/state/omp-kit/composer/` records. The extension shipped in 0.2.72 without an entry, so the registry check `tests/cli/ownership-registry.test.ts` failed on `main` with `UNREGISTERED_PID_WRITER`. The new `composer-state` entry records that the state is keyed by the seat's session, survives a respawn, is removed at shutdown and self-heals after a crash.
