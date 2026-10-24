### Fixed

- `scripts/full-suite-verdict.sh` runs every bun, shell and python suite with SIGINT and SIGQUIT at their defaults, the same as a foreground run.
  - The runner starts its suite loop in a background list, and a non-interactive shell starts background lists with both signals ignored. Every test therefore inherited SIG_IGN.
  - As a result, `tests/scripts/kitlib_tmp_test.py` (test_03_sigint, "want signal SIGINT, got 0") failed only under the gate's full suite.
  - A tiny `python3` exec shim resets the two signals and then execs the suite, so the suite keeps its pid and its process tree (ompkit-lrbd.3).
