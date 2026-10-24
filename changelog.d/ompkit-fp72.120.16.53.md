### Fixed

- `omp-kit service run cc` now starts the command center from the fleet checkout's committed `scripts/cc/cc.py` at HEAD, never the working-tree file, so an uncommitted syntax error in cc.py can no longer stop the live service. A small stdlib bootstrap (`python3 -c`) resolves HEAD with git and execs those bytes with `__file__` set to the adapter path. If the checkout is not its own git top level it prints `DEPLOY_BOOT_GIT_FAILED` and exits 3. (ompkit-fp72.120.16.53)
