### Added

- `omp-kit rch lease --slots N [--worker ID] [--project PATH] [--plan | --apply --yes] -- COMMAND` wraps the native `rch` build lifecycle: it observes worker capacity and disk, admits only healthy or warning workers with enough slots, refuses with a typed capacity reason otherwise, runs the command, and reports next-agent readiness, so any repo that builds on `rch` can use one admission path instead of its own lease script.
