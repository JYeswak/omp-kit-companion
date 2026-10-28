### Fixed

- `omp-kit preflight claim` now refuses a bead carrying an unresolved `needs-director` label with a named NEEDS_DIRECTOR finding, on both the unit predicate path and the supported CLI claim path; an eligible bead still claims, and a recorded director disposition that removes the label re-admits the bead. The new `tests/cli/preflight.test.ts` case pins the refusal, the admitted control, and the resolution with a real fixture tracker. (ompkit-izpwd.1)
