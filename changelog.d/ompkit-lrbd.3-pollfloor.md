### Fixed

- `scripts/full-suite-verdict.sh` now waits on the suite instead of polling it every 5 s, so a verdict takes the suite's own time plus well under a second.
  - The old loop slept a full 5 s before its first check, so even an instant fixture suite paid that floor on every `omp-kit land`.
  - On a trivial fixture suite, the median verdict dropped from 5.41 s to 0.59 s (5 interleaved runs of each).
  - A watchdog still enforces `FULL_SUITE_TIMEOUT_SECS` with the same TERM, 5 s grace, KILL sequence. A timed-out run on a 2 s budget now ends after 2.5 s instead of 10.6 s, with the same verdict: non-pass, nothing cached, partial log kept.
  - No timeout was raised (ompkit-lrbd.3).
