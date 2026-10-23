### Fixed

- `tests/cli/scratch.test.ts` creates its omp-kit state dir 0700, as production does. Under umask 0022, its fixtures used to leave `<state>/omp-kit` at 0755. The `scratch-users` lock correctly refuses a dir like that (`PERMISSIVE_MODE`), so 9 deleter tests read `SKIP users-lock-busy`. The lock is unchanged. A new test pins the refusal: with the state dir at 0755, quarantine expiry keeps an expired entry (`users-lock-busy`), and at 0700 it deletes it. (ompkit-5fn07)
