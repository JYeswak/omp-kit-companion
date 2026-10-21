### Fixed

- Agent Mail validation reads the secret-scanning rule from its fleet-pack location after the rule move. (commit e0c2796)
- Validated Agent Mail sends can receive the current seat's registration token without overriding an explicitly supplied token. (commit c37d804)
- Fleet hook refresh checks installed hook bytes and reports failed or stale refreshes instead of claiming success. (commit d146d19)
- Expose the hooks doctor scope and preserve launchd query failures as unverified service state. (commit 3e78080)
- Remote-build admission accepts finite, nonnegative worker disk-space telemetry in bytes when gigabyte telemetry is absent. (commit fa3c900)
- Fleet restart derives protected panes from fleet configuration. (commit ed8a913)
