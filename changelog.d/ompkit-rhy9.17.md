### Added

- The scratch plan boundary now pins the 72h unowned-active rule with a literal mid-boundary test: a 60-hour-idle unowned dir with no open fds plans LIVE `unowned-but-active`, so a 48h `QUARANTINE_IDLE_MS` drift mutant flips it to QUARANTINE and fails. The test asserts literals only (no shared-constant import), closing the tautological-constant gap alongside the existing totals-forwarding, open-fd guard, and help-policy kill checks.
