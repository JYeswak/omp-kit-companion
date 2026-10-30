### Fixed

- `omp-kit verify` sets `GRADE_WAVE_SCRATCH` to its per-run scratch in every replay's environment (VERIFYSCRATCH1). A selftest that builds fixture trackers under `GRADE_WAVE_SCRATCH` (`grade_wave.py --selftest`) now builds them inside the verify root; the read-only `br` binds implicit fixture-repo operations to that repo's local database, while a tracker outside the root remains refused as `READONLY_TRACKER`.
- Each replay's export now has `var/agent-tmp` (gitignored, so `git archive` omits it), and `KITLIB_TMP_ROOT` names it, as the fresh-gate and full-suite gates provide; a replayed test that asks kitlib for scratch under its repo root no longer fails `NotADirectoryError`.
