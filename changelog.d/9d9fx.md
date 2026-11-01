### Added

- A commit-msg member (`55-omp-kit-commit-gate`) runs the installed push fresh-gate on the commit being made, against `origin/main`, so a commit the push would refuse is refused at commit time and never lands on the shared main where it would hold every later commit off origin. It is a no-op in repos without the push fresh-gate member and never starts a release verdict for the unreferenced candidate.
