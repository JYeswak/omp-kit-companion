### Changed

- Restored `extensions/jev-memory-filter.ts` as a portable vendor: the
  machine-absolute re-export (`/Users/josh/.omp/jev-pinned/...`) is replaced
  by a self-contained local-Clef client (plain fetch to an explicit loopback
  gateway, exact committed calibration plus model fingerprint match, fail-open
  KEEP on every closed outcome). Policy entry restored in
  `policy/extensions.json`; `package.json` records it as profile-installed via
  that policy, not loaded through the plugin manifest.
  Covered by `tests/cli/absolute-imports.test.ts` (ABSIMPORT1: no absolute
  import/export specifiers; every production entrypoint bundles in an exact
  export with an empty HOME) and `tests/cli/jev-memory-filter.test.ts`
  (wire shape, loopback gate, invalid-noul, scoring-off, enforced prune,
  byte-exact round-trip, transport hold).
  (ompkit-ommaa)
