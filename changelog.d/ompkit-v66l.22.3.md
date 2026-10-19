### Fixed
- `kit-update` now re-runs the hook installer for every pull-enabled fleet repo after a successful install, recording each member's before/after sha256. Repos that track their hooks path (e.g. `core.hooksPath=.githooks`) report `PENDING_COMMIT` with the refreshed paths so the owning director commits them under a reservation; kit-update never commits them itself.
- `omp-kit doctor --scope hooks` lists, per fleet repo, the hook members whose digest differs from the active release.
