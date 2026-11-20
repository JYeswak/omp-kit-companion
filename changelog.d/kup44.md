### Fixed

- `omp-kit doctor --scope lsp --deep` keeps the explanation of a classified outcome when the readiness gate also failed: a server that exits during initialize is reported as having exited, with the readiness failure added as detail instead of replacing it. Native certification of the compiled immediate-exit case no longer refuses every platform.
