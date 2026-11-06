### Fixed

- The release's next-version advance commits through the commit hooks again: its subject carries a proof level (`[pending]`), and the commit gate's README release-line check reads tags from the canonical repository instead of the gate's archive copy, where an initialized `.git` hid the published tag and reported it absent. (ompkit-1ra0d.19, RELADVANCE1; diagnosis by builder TopazGate)
