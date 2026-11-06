### Fixed
- Release and verdict gates use one kit-owned PATH and locale instead of the invoking shell; verdict records retain the judged environment, and genuine runtime mismatches still refuse reuse.
- Prefer Tern's native OMP launcher when installed, preventing user trust wrappers from hiding launcher versions in fixture homes.
