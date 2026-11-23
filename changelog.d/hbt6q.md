### Fixed

- `omp-kit land` now schedules the release qualification for the head it published, so a main commit gets its main-role full-suite verdict by itself and autocut can cut a release without a hand-run verdict. The pre-push hook that scheduled it never ran for a land push because the exact-parent publication pushes from a private checkout that has no hook chain; the detached child (quiet interval, supersession by a newer head, then scripts/release-verdict.sh) now lives in `scripts/release-verdict-start.py`, shared by the hook and by land. `OMP_KIT_RELEASE_VERDICT=0` opts out as before.
