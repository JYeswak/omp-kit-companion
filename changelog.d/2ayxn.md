### Fixed

- The Agent Mail storage-root gate (ompkit-2ayxn) refuses a commit when the hook chain did not hand the resolved archive root to the Agent Mail guard. An Agent Mail hook reinstall rewrites the chain runner and drops the omp-kit bootstrap; the guard then read its own default root, matched no archive and allowed every commit, so exclusive reservations went unchecked. The refusal names the remedy: re-run `scripts/install-pre-commit-storage-root-gate.sh`.
