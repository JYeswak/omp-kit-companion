### Added

- A pre-commit member (`55-omp-kit-staged-wallclock`) refuses new test lines that pass only within a fixed wall-clock bound under 10 s (a child `deadline_s`/`timeout_s`, a spawn `timeout`/`timeoutMs` under 10000 ms, a Python `timeout=`, or an elapsed-time `toBeLessThan`) unless the line is annotated `wallclock: p99=<measured> headroom=<factor>`; untouched existing lines never block. `scripts/wallclock_check.py --inventory` lists every such line.
