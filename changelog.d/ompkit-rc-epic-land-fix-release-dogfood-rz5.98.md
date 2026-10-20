### Added

- MP6 cross-session registry: one machine-local row per fleet session
  (`src/session-registry.ts`), seeded from
  `uds/registries/upgrade_policy.toml` (holds, no-upgrade windows) and each
  session mission record's blast radius (owner pane, shared binaries with
  version floors, blast radius), every field with its source recorded.
  `validateSessionRegistry` refuses rows missing a field or a source,
  `findOverlaps` flags multi-owner binaries/paths/session-scopes for MP2,
  and `checkHoldViolations` reports installed binaries below a pinned floor
  (e.g. jev's br 0.7.4). Live seed: 5 sessions enumerated; omp-test and jev
  complete; uds (no mission record), localbench and cfsios (no owner pane
  declared) reported incomplete with named errors. uds-lane cutover reads the
  generated `session-registry.json` instead of the embedded checkout copy.
  (ompkit-rc-epic-land-fix-release-dogfood-rz5.98)
