### Fixed

- Every `scripts/install-*.sh` refuses an argument it does not know with a usage
  line and exit 2 before anything is written (ompkit-t7cn7.9). Previously only
  `install-extensions.sh` refused (and only `$1`); the rest ignored unknown
  flags, and `install-pre-push-gate.sh --check` installed the fresh gate
  instead of reporting. `install-pre-push-gate.sh` gains a read-only `--check`
  matching `install-commit-msg-bead.sh`: exit 3 with `MISSING`/`STALE` lines
  when the installed `40-omp-kit-fresh-gate` member differs from the repo's
  `scripts/pre-push-gate.sh`, exit 0 with `hooks fresh` when current, no writes
  in any `--check` path. Covered by `tests/cli/install-flags.test.sh`
  (45 assertions: per-script planted unknown flags, extra positionals, and
  missing/fresh/stale check runs, each proving byte-identical hooks).
