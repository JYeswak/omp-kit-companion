### Fixed

- Fleet restart copies held scratch out of reaper roots and pins each dirty repo on `refs/preserve/fleet-restart/` before any send. A preserve failure refuses the run. The shared index and worktree are not moved. [test]
