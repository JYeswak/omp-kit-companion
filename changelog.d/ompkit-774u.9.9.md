### Fixed

- Keep Bun compile scratch inside the package build's owned temporary directory, and have the scratch reaper remove stale root-level `.bun-build` leftovers only after an age and open-file safety check.
