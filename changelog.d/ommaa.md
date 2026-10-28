### Removed

- Removed `extensions/jev-memory-filter.ts`, which re-exported a machine-absolute
  path (`/Users/josh/.omp/jev-pinned/...`) unresolvable on any other machine.
  The extension was profile-installed but imported nowhere in the repo; keeping it
  broke `bun build` and the official release packaging on clean checkouts. Its
  policy entry is removed from `policy/extensions.json` alongside.
  Covered by `tests/cli/absolute-imports.test.ts` (ABSIMPORT1: no absolute
  import/export specifiers in `src/`, `extensions/`, `scripts/`; every
  production entrypoint bundles in an exact export with an empty HOME).
  (ompkit-ommaa)
