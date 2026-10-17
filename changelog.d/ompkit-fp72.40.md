### Fixed

- An interrupted push gate no longer loses its failure log: on SIGINT/SIGTERM the gate marks the run red before cleanup, shuts down its owned pipeline children (TERM-only), removes the extract tree, and keeps exactly `.owner` plus `gate.log` naming the dead gate pid, with exit 130/143. Contract: new `term-interrupt-keeps-log-not-tree` case in `tests/cli/pre-push-gate.test.sh` (28/28 under sh and dash). [test]
