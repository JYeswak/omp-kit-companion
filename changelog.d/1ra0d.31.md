### Fixed
- Release and verdict gates use one kit-owned PATH and locale instead of the invoking shell; verdict records retain the judged environment, and genuine runtime mismatches still refuse reuse.
- Prefer Tern's native OMP launcher when installed, preventing user trust wrappers from hiding launcher versions in fixture homes.
- Qualification constructs an explicit allowlisted child environment for release, verdict, focused-suite and Python-only storegate checks. Caller profile, Git, tracker and arbitrary variables cannot poison execution or cached PASS reuse; candidate-authored identity conflicts still fail.
