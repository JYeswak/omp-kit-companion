### Fixed

- `omp-kit service doctor kit-update` now reports FAIL on a named `kit-update-config` check when the job is installed and loaded but carries neither poll (`OMP_KIT_UPDATE_POLL=github` with `OMP_KIT_UPDATE_REPO=owner/repo`) nor static (`OMP_KIT_UPDATE_INDEX`, `OMP_KIT_UPDATE_ARCHIVE`, `OMP_KIT_UPDATE_VERSION`, `OMP_KIT_UPDATE_SOURCE_TAG`) configuration; every run in that state refuses `KIT_UPDATE_JOB_CONFIG`, so the silent bare-shell reinstall that strips the config is now named instead of staying green.
