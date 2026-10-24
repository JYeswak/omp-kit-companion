### Fixed

- The full-suite pre-push verdict no longer throws away the suite output when a run ends without complete evidence or times out. The partial output is kept as `<tree>.incomplete.log` in the verdict cache dir and the RED line prints its path. The run still exits non-pass and caches no verdict, and the verdict lookup only reads `<tree>.json` and `<tree>.log`, so the kept log can never be reused as a verdict. (ompkit-lrbd.6)
