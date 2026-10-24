### Fixed

- `tests/cli/repair.test.ts` runs in the local full-suite and pre-push gates again. Its `scripts/gate-ci-only.tsv` hermeticity row is removed now that the HOME-snapshot differences are fixed: the rch socket baseline is written only by `doctor`, and the compiled repair child no longer sees the host omp (ompkit-lrbd.3). The file passed 5/5 in an exact-commit export at 4-way concurrency (ompkit-v66l.27.9).
