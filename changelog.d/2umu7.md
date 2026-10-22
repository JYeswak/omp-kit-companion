### Fixed

- `scripts/release-local.sh` now refuses to run under `sh` or bash's POSIX mode and exits 2 with the command to use. Run as `sh` on macOS, it built the archives and then stopped at the signing stage, yet still exited 0. A caller reading only the exit code would believe the release had succeeded.
