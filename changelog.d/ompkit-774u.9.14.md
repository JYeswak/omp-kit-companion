### Fixed

- `omp-kit scratch new` releases ledger reservations whose scratch directory no longer exists before checking the seat budget, so dirs removed by tests or interrupted cleanup stop blocking new scratch. (ompkit-774u.9.14)
