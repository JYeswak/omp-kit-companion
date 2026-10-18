### Fixed
- Complete stock-plugin acceptance for the shared repository-local `.omp/fleet.json` opt-in: absent markers admit temporary writes and ordinary Git operations, leave dirty-session stops nonblocking, and create no consumer fleet scratch state. Existing opted-in enforcement remains intact.
- Exercise both missing policy-directory and missing marker-file paths with real owned temporary-file, disposable-branch and index effects. System `/tmp` targets are admission-only probes, never test writes outside owned scratch.
- Add a separate non-shipping `fleet-default-on` CI control that changes only the two absent-marker defaults, preserving explicit false and malformed-policy behavior as well as the callback and compaction controls.
