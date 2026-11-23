### Fixed

- `omp-kit update --apply` on a clean home no longer exits 1 with 23 `MANIFEST_APPLY_FAILED` errors after a successful install. A service job the host never set up (no plist or unit) whose install refuses with `LAUNCHER_UNAVAILABLE`, `FLEET_ADAPTER_ABSENT` or `*_UNCONFIGURED` is listed under `manifest.skipped`, and a rules pack blocked by a locally edited managed rule is listed there too (the edit is untouched; the entry names the files and `omp-kit migrate --plan`). An installed job that fails and any other refusal still fail the update.
