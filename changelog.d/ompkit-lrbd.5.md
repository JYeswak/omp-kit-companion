### Added

- `scripts/check-suite-runtime.sh`: cli-contracts runtime guard. Times the suite command, prints `SUITE_RUNTIME_SECS=<n>`, exits 1 with `RUNTIME_REGRESSION` when elapsed meets the 20-minute budget (a run near the limit is a regression, not a pass), otherwise propagates the command's exit code. No timeout is raised. Contract: `tests/cli/suite-runtime.test.sh` (6/6). [test]
