### Fixed

- The commit-imports gate finds the host TypeScript library past a launcher shim: it tries every `tsc` on `PATH` in order and loads the first whose real path has a sibling `lib/typescript.js`. Before, a pnpm global `~/.local/bin/tsc` first on `PATH` (as on headless builders) made every TypeScript commit fail `PARSER_UNAVAILABLE`. A candidate compiler inside the repository is still refused. (ompkit-1ra0d.1, TSCSHIM1)
