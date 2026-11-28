### Fixed
- `test --repeat` starts scenarios with the installed kit's isolated OMP launcher. A launcher failure, interrupted run, or incomplete scenario report returns `UNVERIFIED` with a nonzero exit and does not count toward flake statistics.
