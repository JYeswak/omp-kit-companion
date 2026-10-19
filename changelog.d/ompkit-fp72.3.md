### Fixed

- Release packaging stamps the `--version` value into the archived `package.json` (`version` and `omp.version`), and kit-release verification refuses an archive whose `package.json` disagrees with its release manifest (`PACKAGE_VERSION_MISMATCH`). (ompkit-fp72.3)
- Doctor compares each profile's plugin lock version against the installed release manifest instead of the unstamped `package.json`, and reports `DEGRADED` with the stable code `versionMismatch` (`<lock> vs <installed>`) in both the `plugin_links` and the `effective_rules` findings. (ompkit-fp72.3)
